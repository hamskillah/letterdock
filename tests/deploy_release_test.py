#!/usr/bin/env python3
"""Isolated host-protocol tests. All Docker and network operations are fakes."""
import fcntl
import os
import shutil
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'deploy/release.sh'
SHA = 'a' * 40
FAKE = r'''#!/usr/bin/env python3
import os, sys
from pathlib import Path
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['LOG'], 'a') as f: f.write(name + ' ' + ' '.join(args) + '\n')
if name == 'curl':
    sys.stdin.read()
    counter = Path(os.environ['LOG'] + '.curl')
    n = int(counter.read_text()) + 1 if counter.exists() else 1
    counter.write_text(str(n))
    print('{"sha":"' + (os.environ.get('TIP2', 'a'*40) if n > 1 else os.environ.get('TIP', 'a'*40)) + '"}')
elif name == 'sleep': pass
elif name == 'sudo':
    if 'config' in args:
        config_count = Path(os.environ['LOG'] + '.config')
        n = int(config_count.read_text()) + 1 if config_count.exists() else 1
        config_count.write_text(str(n))
        if (os.environ.get('FAIL') == 'config' and n > 1) or (os.environ.get('FAIL') == 'config-after' and (Path(os.environ['LIVE']) / 'compose.override.yml').exists()):
            print('fixture-sensitive-config-value', file=sys.stderr)
            sys.exit(1)
        print('{"name":"letterdock","services":{"app":{"environment":{"SECRET":"fixture-sensitive-config-value"}}}}')
    elif 'build' in args and os.environ.get('FAIL') == 'build': sys.exit(1)
    if 'pg_dump' in args:
        if os.environ.get('FAIL') == 'backup': sys.exit(1)
        if os.environ.get('FAIL') == 'empty-backup': sys.exit(0)
        print('fake dump')
    elif 'pg_restore' in args:
        if not sys.stdin.read() or os.environ.get('FAIL') == 'restore-check': sys.exit(1)
    elif 'pg_isready' in args or 'node' in args:
        if os.environ.get('FAIL') == 'hang-' + ('db' if 'pg_isready' in args else 'app'):
            import time
            time.sleep(5)
        if os.environ.get('FAIL') == 'health': sys.exit(1)
    elif 'ps' in args and '-q' in args: print('container-id')
    elif 'inspect' in args:
        if '--format' not in args:
            if 'image' in args:
                print('[{"Config":{"Env":[]}}]')
            else:
                print('[{"Image":"sha256:1234","State":{"Running":true},"Config":{"Env":["SECRET=fixture-sensitive-config-value"]},"Mounts":[],"HostConfig":{"PortBindings":{}}}]')
        elif '{{.Image}}' in args: print('sha256:1234')
        elif 'config_files' in ' '.join(args):
            live = Path(os.environ['LIVE'])
            print(str(live / 'compose.yml') + ',' + str(live / 'deploy/compose.domain-connect.example.yml'))
        else: print('letterdock')
    elif 'up' in args and os.environ.get('FAIL') == 'cutover': sys.exit(1)
'''

class DeploymentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='letterdock-test-')
        self.root = Path(self.tmp.name)
        self.live = self.root / 'live'
        self.candidate = self.root / 'candidate'
        self.bin = self.root / 'bin'
        for p in (self.live, self.candidate, self.bin): p.mkdir()
        (self.live / '.env').write_text('not-a-real-secret\n')
        (self.live / 'compose.yml').write_text('services: {}\n')
        (self.candidate / 'compose.yml').write_text('services: {}\n')
        for p in (self.live, self.candidate):
            (p / 'deploy').mkdir()
            (p / 'deploy/compose.domain-connect.example.yml').write_text('same\n')
        shutil.copyfile(SCRIPT.parent / 'compare-compose.py', self.candidate / 'deploy/compare-compose.py')
        shutil.copyfile(SCRIPT.parent / 'check-running.py', self.candidate / 'deploy/check-running.py')
        for name in ('sudo', 'curl', 'sleep'):
            p = self.bin / name
            p.write_text(FAKE)
            p.chmod(0o755)
        self.log = self.root / 'calls'
        self.env = {**os.environ, 'PATH': str(self.bin) + ':' + os.environ['PATH'],
                    'HOME': str(self.root), 'LOG': str(self.log), 'LIVE': str(self.live)}

    def tearDown(self): self.tmp.cleanup()

    def run_deploy(self, **env):
        return subprocess.run(['bash', str(SCRIPT), str(self.live), str(self.candidate),
                               SHA, 'owner/repo', '123-1'], input='test-token\n', text=True,
                              capture_output=True, env={**self.env, **env}, timeout=15)

    def calls(self): return self.log.read_text() if self.log.exists() else ''

    def test_success_and_order(self):
        r = self.run_deploy()
        self.assertEqual(r.returncode, 0, r.stderr)
        calls = self.calls()
        self.assertLess(calls.index(' build '), calls.index('curl '))
        self.assertLess(calls.index('curl '), calls.index('pg_dump'))
        self.assertLess(calls.index('pg_restore'), calls.index(' up '))
        self.assertIn('-p letterdock -f ' + str(self.live / 'compose.yml'), calls)
        self.assertIn('--no-deps --no-build app', calls)
        self.assertEqual(calls.count('curl '), 2)
        self.assertTrue((self.live / 'compose.override.yml').exists())
        self.assertEqual((self.live / '.env').read_text(), 'not-a-real-secret\n')
        self.assertEqual((self.root / 'letterdock-backups/letterdock-123-1.dump').stat().st_mode & 0o777, 0o600)
        self.assertNotIn('test-token', calls + r.stdout + r.stderr)
        self.assertNotIn('fixture-sensitive-config-value', calls + r.stdout + r.stderr)
        for file in self.candidate.rglob('*'):
            if file.is_file(): self.assertNotIn(b'fixture-sensitive-config-value', file.read_bytes())

    def test_stale_and_failures_stop_cutover(self):
        for config in ({'TIP': 'b'*40}, {'TIP2': 'b'*40}, {'FAIL': 'build'}, {'FAIL': 'backup'}, {'FAIL': 'empty-backup'}, {'FAIL': 'restore-check'}):
            with self.subTest(config=config), tempfile.TemporaryDirectory(prefix='letterdock-case-') as root:
                # Each attempt must have a fresh backup destination and call log.
                self.env['HOME'] = root
                self.log.unlink(missing_ok=True)
                Path(str(self.log) + '.curl').unlink(missing_ok=True)
                Path(str(self.log) + '.config').unlink(missing_ok=True)
                r = self.run_deploy(**config)
                self.assertNotEqual(r.returncode, 0)
                self.assertNotIn(' up ', self.calls())
                self.assertFalse((self.live / 'compose.override.yml').exists())

    def test_config_command_failure_is_closed_and_redacted(self):
        for failure in ('config', 'config-after'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix='letterdock-case-') as root:
                self.env['HOME'] = root
                self.log.unlink(missing_ok=True)
                r = self.run_deploy(FAIL=failure)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('Unable to resolve or parse Compose configuration', r.stderr)
                self.assertNotIn('fixture-sensitive-config-value', r.stdout + r.stderr)
                self.assertEqual(' up ' in self.calls(), failure == 'config-after')
                marker = Path(str(self.live) + '.deploy-needs-review')
                self.assertEqual(marker.exists(), failure == 'config-after')
                if marker.exists(): marker.unlink()
                override = self.live / 'compose.override.yml'
                if override.exists(): override.unlink()

    def test_compose_change_rejected(self):
        (self.candidate / 'compose.yml').write_text('changed\n')
        self.assertNotEqual(self.run_deploy().returncode, 0)
        self.assertEqual(self.calls(), '')

    def test_cutover_and_health_failure_do_not_rollback(self):
        for failure in ('cutover', 'health'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix='letterdock-case-') as root:
                self.env['HOME'] = root
                self.log.unlink(missing_ok=True)
                self.assertNotEqual(self.run_deploy(FAIL=failure).returncode, 0)
                calls = self.calls()
                self.assertEqual(calls.count(' up '), 1)
                self.assertIn('pg_restore', calls)
                self.assertTrue(Path(str(self.live) + '.deploy-needs-review').exists())
                self.log.unlink()
                self.assertNotEqual(self.run_deploy().returncode, 0)
                self.assertEqual(self.calls(), '')
                Path(str(self.live) + '.deploy-needs-review').unlink()

    def test_hung_health_command_is_bounded(self):
        timeout = self.bin / 'timeout'
        timeout.write_text('#!/bin/sh\n[ "$1" = "--kill-after=2s" ] && [ "$2" = "10s" ] || exit 2\nshift 2\nexec /usr/bin/timeout --kill-after=1s 0.1s "$@"\n')
        timeout.chmod(0o755)
        for service in ('db', 'app'):
            with self.subTest(service=service), tempfile.TemporaryDirectory(prefix='letterdock-case-') as root:
                self.env['HOME'] = root
                self.log.unlink(missing_ok=True)
                result = self.run_deploy(FAIL='hang-' + service)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Health check failed', result.stderr)
                marker = Path(str(self.live) + '.deploy-needs-review')
                self.assertTrue(marker.exists())
                self.assertEqual(self.calls().count('pg_isready'), 20)
                if service == 'app': self.assertEqual(self.calls().count(' node '), 20)
                marker.unlink()

    def test_host_lock_serializes_deployments(self):
        lock = open(str(self.live) + '.deploy.lock', 'w')
        fcntl.flock(lock, fcntl.LOCK_EX)
        proc = subprocess.Popen(['bash', str(SCRIPT), str(self.live), str(self.candidate),
                                 SHA, 'owner/repo', '123-1'], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, env=self.env)
        try:
            proc.stdin.write('test-token\n')
            proc.stdin.close()
            try:
                proc.wait(timeout=0.4)
                self.fail('deployment bypassed held lock')
            except subprocess.TimeoutExpired:
                self.assertEqual(self.calls(), '')
            fcntl.flock(lock, fcntl.LOCK_UN)
            self.assertEqual(proc.wait(timeout=15), 0, proc.stderr.read())
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            lock.close()
            if proc.poll() is None:
                proc.kill()
                proc.wait()
            proc.stdout.close()
            proc.stderr.close()

    def test_backup_collision_does_not_replace_dump(self):
        self.assertEqual(self.run_deploy().returncode, 0)
        dump = self.root / 'letterdock-backups/letterdock-123-1.dump'
        original = dump.read_bytes()
        self.log.unlink()
        self.assertNotEqual(self.run_deploy().returncode, 0)
        self.assertEqual(dump.read_bytes(), original)
        self.assertNotIn(' up ', self.calls())

if __name__ == '__main__': unittest.main()
