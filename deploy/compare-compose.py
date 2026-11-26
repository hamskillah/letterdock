#!/usr/bin/env python3
"""Compare resolved Compose models in memory without logging their contents."""
import json
import subprocess
import sys


def model(command):
    try:
        result = subprocess.run(command + ['config', '--format', 'json'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        return json.loads(result.stdout)
    except (OSError, subprocess.CalledProcessError, ValueError):
        # Compose diagnostics can contain interpolated values; never echo them.
        sys.exit('Unable to resolve or parse Compose configuration')


def main():
    if len(sys.argv) != 5 or sys.argv[1] not in ('before', 'after'):
        sys.exit('Invalid comparison arguments')
    phase, live, project, override = sys.argv[1:]
    common = ['sudo', 'docker', 'compose', '--project-directory', live, '-p', project,
              '-f', live + '/compose.yml']
    proposed = model(common + ['-f', override])
    if phase == 'before':
        baseline = model(common + ['-f', live + '/deploy/compose.domain-connect.example.yml'])
        try:
            for value in (baseline, proposed):
                value['services']['app'].pop('image', None)
            baseline['services']['app'].pop('build', None)
            if 'build' in proposed['services']['app']:
                sys.exit('Proposed app build must be disabled')
        except (KeyError, TypeError, AttributeError):
            sys.exit('Compose configuration is missing the app service')
        if baseline != proposed:
            sys.exit('Effective configuration differs beyond app image')
        default = model(['sudo', 'docker', 'compose'])
        if default.get('name') != project:
            sys.exit('Default Compose project differs from running project')
    else:
        default = model(['sudo', 'docker', 'compose'])
        if default != proposed:
            sys.exit('Default Compose model differs; interlock retained')


if __name__ == '__main__':
    main()
