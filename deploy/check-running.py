#!/usr/bin/env python3
"""Fail closed on supported running-app environment, mount and port drift.

Resolved config and inspect results are held in memory and never printed.
"""
import json
import os
import subprocess
import sys


def read_json(command):
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                check=True, timeout=30)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        sys.exit('Unable to inspect running configuration')


def fail(kind):
    sys.exit('Running app ' + kind + ' differs from the Compose baseline or is unsupported')


def environment(items):
    result = {}
    for item in items or []:
        key, sep, value = item.partition('=')
        if not sep or not key or key in result:
            fail('environment')
        result[key] = value
    return result


def check(live, project, container):
    base = ['sudo', 'docker', 'compose', '--project-directory', live, '-p', project,
            '-f', live + '/compose.yml', '-f', live + '/deploy/compose.domain-connect.example.yml']
    model = read_json(base + ['config', '--format', 'json'])
    inspected = read_json(['sudo', 'docker', 'inspect', container])
    if len(inspected) != 1:
        fail('container')
    actual = inspected[0]
    if not actual['State']['Running']:
        fail('container')
    images = read_json(['sudo', 'docker', 'image', 'inspect', actual['Image']])
    if len(images) != 1:
        fail('image')
    service = model['services']['app']
    expected_env = environment(images[0]['Config'].get('Env'))
    for key, value in (service.get('environment') or {}).items():
        if not isinstance(value, str):
            fail('environment')
        expected_env[key] = value
    if expected_env != environment(actual['Config'].get('Env')):
        fail('environment')

    expected_mounts = {}
    for volume in service.get('volumes', []):
        kind = volume.get('type')
        target = volume.get('target')
        source = volume.get('source')
        if kind not in ('bind', 'volume') or not target or not source:
            fail('mounts')
        if kind == 'bind':
            source = os.path.realpath(source)
        else:
            source = (model.get('volumes', {}).get(source) or {}).get('name', source)
        if target in expected_mounts:
            fail('mounts')
        expected_mounts[target] = (kind, source, not volume.get('read_only', False))
    for secret in service.get('secrets', []):
        source = (model.get('secrets', {}).get(secret['source']) or {}).get('file')
        target = secret.get('target') or '/run/secrets/' + secret['source']
        if not source or target in expected_mounts:
            fail('mounts')
        expected_mounts[target] = ('bind', os.path.realpath(source), False)
    # Docker creates anonymous volumes for undeclared image VOLUME targets.
    for target in (images[0]['Config'].get('Volumes') or {}):
        if target not in expected_mounts:
            expected_mounts[target] = ('volume', None, True)
    running_mounts = {}
    for mount in actual.get('Mounts', []):
        kind, target = mount['Type'], mount['Destination']
        source = mount.get('Name') if kind == 'volume' else mount.get('Source')
        if kind not in ('bind', 'volume') or not source or target in running_mounts:
            fail('mounts')
        if kind == 'bind':
            source = os.path.realpath(source)
        if target in expected_mounts and expected_mounts[target][1] is None:
            source = None
        running_mounts[target] = (kind, source, mount['RW'])
    if expected_mounts != running_mounts:
        fail('mounts')

    if service.get('network_mode') or actual['HostConfig'].get('NetworkMode') in ('host', 'none'):
        fail('ports')
    expected_ports = []
    for port in service.get('ports', []):
        if not port.get('published') or not port.get('target'):
            fail('ports')
        expected_ports.append((str(port['target']) + '/' + port.get('protocol', 'tcp'),
                               port.get('host_ip') or '0.0.0.0', str(port['published'])))
    running_ports = []
    for key, bindings in (actual['HostConfig'].get('PortBindings') or {}).items():
        for binding in bindings or []:
            running_ports.append((key, binding.get('HostIp') or '0.0.0.0', binding['HostPort']))
    if sorted(expected_ports) != sorted(running_ports):
        fail('ports')


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit('Invalid running configuration check arguments')
    try:
        check(*sys.argv[1:])
    except (KeyError, TypeError, ValueError, AttributeError, IndexError):
        sys.exit('Unsupported running configuration')
