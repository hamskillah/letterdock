#!/usr/bin/env python3
"""Real Compose lifecycle in a unique project; fake only GitHub and app HTTP.

Uses the local postgres:17 image and a dynamically selected loopback port, and
never references any existing project. Requires Docker, Compose and postgres:17 locally.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'deploy/release.sh'
OVERLAY = ROOT / 'deploy/compose.domain-connect.example.yml'
SHA = 'a' * 40

class ComposeLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ldtest-', dir='/tmp/opencode' if Path('/tmp/opencode').is_dir() else None)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.project = 'ldtest' + uuid.uuid4().hex[:12]
        self.live = self.root / self.project
        self.candidate = Path(str(self.live) + '.releases') / '1-1'
        self.candidate.parent.mkdir()
        self.bin = self.root / 'bin'
        for d in (self.live, self.candidate, self.bin): d.mkdir()
        for d in (self.live, self.candidate):
            (d / 'deploy').mkdir()
            shutil.copyfile(OVERLAY, d / 'deploy/compose.domain-connect.example.yml')
        shutil.copyfile(ROOT / 'deploy/compare-compose.py', self.candidate / 'deploy/compare-compose.py')
        shutil.copyfile(SCRIPT.parent / 'check-running.py', self.candidate / 'deploy/check-running.py')
        self.secret = self.root / 'dummy.pem'
        self.secret.write_text('fixture-not-a-private-key\n')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.env_text = ('POSTGRES_PASSWORD=test_password\nDOMAIN_CONNECT_PROVIDER_ID=test-provider\n'
                         'FIXTURE_ENV=original\nAPP_PORT=' + str(self.port) +
                         '\nDOMAIN_CONNECT_SIGNING_KEY_PATH=' + str(self.secret) + '\n')
        (self.live / '.env').write_text(self.env_text)
        compose = '''services:
  db:
    image: postgres:17
    environment:
      POSTGRES_DB: letterdock
      POSTGRES_USER: letterdock
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?required}
    volumes:
      - database:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U letterdock -d letterdock"]
      interval: 1s
      timeout: 2s
      retries: 30
  app:
    image: FIXTURE_IMAGE
    build: .
    entrypoint: ["sleep", "infinity"]
    environment:
      FIXTURE_ENV: ${FIXTURE_ENV:?required}
    ports:
      - "127.0.0.1:${APP_PORT:?required}:3000"
    depends_on:
      db:
        condition: service_healthy
volumes:
  database:
'''
        compose = compose.replace('FIXTURE_IMAGE', self.project + '-live:fixture')
        for d in (self.live, self.candidate): (d / 'compose.yml').write_text(compose)
        (self.live / 'Dockerfile').write_text('FROM postgres:17\nCOPY node /usr/local/bin/node\n')
        (self.live / 'node').write_text('#!/bin/sh\nexit 0\n# stale live source\n')
        (self.live / 'node').chmod(0o755)
        (self.candidate / 'Dockerfile').write_text('FROM postgres:17\nCOPY node /usr/local/bin/node\n')
        (self.candidate / 'node').write_text('#!/bin/sh\nexit 0\n')
        (self.candidate / 'node').chmod(0o755)
        (self.bin / 'sleep').write_text('#!/bin/sh\nexit 0\n')
        (self.bin / 'sudo').write_text('#!/bin/sh\nexec "$@"\n')
        (self.bin / 'curl').write_text('#!/bin/sh\ncat >/dev/null\nprintf \'{"sha":"' + SHA + '"}\\n\'\n')
        for p in self.bin.iterdir(): p.chmod(0o755)
        self.env = {**os.environ, 'HOME': str(self.root), 'PATH': str(self.bin) + ':' + os.environ['PATH']}
        for key in list(self.env):
            if key.startswith('COMPOSE_'): self.env.pop(key)
        self.compose = ['docker', 'compose', '--project-directory', str(self.live), '-p', self.project,
                        '-f', str(self.live / 'compose.yml'), '-f', str(self.live / 'deploy/compose.domain-connect.example.yml')]
        self.cleaned = False
        self.addCleanup(self.cleanup_project)
        self.run_cmd(self.compose + ['up', '-d', '--wait', '--build'], timeout=120)

    def run_cmd(self, args, **kwargs):
        return subprocess.run(args, cwd=self.live, env=self.env, check=True, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)

    def cleanup_project(self):
        if self.cleaned:
            return
        # The project and volume names are generated uniquely by this test.
        # Compose is always invoked with the explicit project and fixture files.
        self.run_cmd(self.compose + ['down', '--volumes'], timeout=60)
        volume = self.project + '_database'
        remaining = self.run_cmd(['docker', 'volume', 'ls', '--filter', 'name=^' + volume + '$',
                                  '--format', '{{.Name}}']).stdout.splitlines()
        if volume in remaining:
            raise AssertionError('Test volume still exists: ' + volume)
        self.cleaned = True

    def test_overlay_and_repeated_default_up(self):
        before = json.loads(self.run_cmd(self.compose + ['config', '--format', 'json']).stdout)
        old = self.run_cmd(['docker', 'inspect', '--format', '{{.Image}}',
                            self.run_cmd(self.compose + ['ps', '-q', 'app']).stdout.strip()]).stdout.strip()
        run = str(int(time.time() * 1000000)) + '-1'
        # Modify only fixture interpolation; running container remains unchanged.
        other_secret = self.root / 'other-dummy.pem'
        other_secret.write_text('another-fixture-not-a-private-key\n')
        drifts = (
            ('environment', self.env_text.replace('FIXTURE_ENV=original', 'FIXTURE_ENV=changed')),
            ('mounts', self.env_text.replace(str(self.secret), str(other_secret))),
            ('ports', self.env_text.replace('APP_PORT=' + str(self.port), 'APP_PORT=1')),
        )
        for kind, altered in drifts:
            with self.subTest(drift=kind):
                (self.live / '.env').write_text(altered)
                drifted = subprocess.run(['bash', str(SCRIPT), str(self.live), str(self.candidate), SHA,
                                          'owner/repo', run], input='fixture-token\n', cwd=self.live,
                                         env=self.env, text=True, capture_output=True, timeout=60)
                self.assertNotEqual(drifted.returncode, 0)
                self.assertIn('Running app ' + kind + ' differs', drifted.stderr)
                self.assertFalse((self.root / 'letterdock-backups').exists())
                self.assertFalse((self.live / 'compose.override.yml').exists())
                self.assertNotIn('test-provider', drifted.stdout + drifted.stderr)
                self.assertNotIn('FIXTURE_ENV', drifted.stdout + drifted.stderr)
                (self.live / '.env').write_text(self.env_text)
        # Existing unmanaged implicit overrides must never be clobbered.
        user_override = self.live / 'compose.override.yml'
        user_override.write_text('services: {}\n')
        rejected = subprocess.run(['bash', str(SCRIPT), str(self.live), str(self.candidate), SHA,
                                   'owner/repo', run], input='fixture-token\n', cwd=self.live,
                                  env=self.env, text=True, capture_output=True, timeout=90)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(user_override.read_text(), 'services: {}\n')
        user_override.unlink()
        # Real pg_dump completes, then the second GitHub check reports stale.
        counter = self.root / 'requests'
        curl = self.bin / 'curl'
        curl.write_text(f"#!/bin/sh\ncat >/dev/null\nn=0; [ ! -f '{counter}' ] || n=$(cat '{counter}')\nn=$((n+1)); echo \"$n\" > '{counter}'\nif [ \"$n\" -eq 1 ]; then echo '{{\"sha\":\"{SHA}\"}}'; else echo '{{\"sha\":\"{'b'*40}\"}}'; fi\n")
        stale = subprocess.run(['bash', str(SCRIPT), str(self.live), str(self.candidate), SHA,
                                'owner/repo', run], input='fixture-token\n', cwd=self.live,
                               env=self.env, text=True, capture_output=True, timeout=180)
        self.assertNotEqual(stale.returncode, 0, stale.stderr)
        self.assertIn('Stale deployment', stale.stderr)
        self.assertTrue((self.root / 'letterdock-backups' / ('letterdock-' + run + '.dump')).stat().st_size > 0)
        self.assertFalse(user_override.exists())
        self.assertEqual(self.run_cmd(['docker', 'inspect', '--format', '{{.Image}}',
                            self.run_cmd(self.compose + ['ps', '-q', 'app']).stdout.strip()]).stdout.strip(), old)
        curl.write_text(f"#!/bin/sh\ncat >/dev/null\necho '{{\"sha\":\"{SHA}\"}}'\n")
        run = str(int(time.time() * 1000000)) + '-1'
        result = subprocess.run(['bash', str(SCRIPT), str(self.live), str(self.candidate), SHA,
                                 'owner/repo', run], input='fixture-token\n', cwd=self.live,
                                env=self.env, text=True, capture_output=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr)
        default = ['docker', 'compose']
        after = json.loads(self.run_cmd(default + ['config', '--format', 'json']).stdout)
        self.assertEqual(after['services']['app']['environment']['DOMAIN_CONNECT_PROVIDER_ID'], 'test-provider')
        self.assertEqual(after['services']['app']['environment']['DOMAIN_CONNECT_KEY_FILE'], '/run/secrets/domain_connect_key')
        self.assertEqual(after['services']['app']['secrets'], before['services']['app']['secrets'])
        self.assertEqual(after['secrets'], before['secrets'])
        self.assertEqual(after['volumes'], before['volumes'])
        self.assertEqual(after['services']['app']['image'], 'letterdock-candidate:' + run)
        self.assertIn('build', before['services']['app'])
        self.assertNotIn('build', after['services']['app'])
        app = self.run_cmd(default + ['ps', '-q', 'app']).stdout.strip()
        mounted = json.loads(self.run_cmd(['docker', 'inspect', app]).stdout)[0]['Mounts']
        self.assertTrue(any(m['Destination'] == '/run/secrets/domain_connect_key' for m in mounted))
        new = self.run_cmd(['docker', 'inspect', '--format', '{{.Image}}', app]).stdout.strip()
        self.assertNotEqual(new, old)
        for _ in range(2):
            self.run_cmd(default + ['up', '-d', '--build'])
            app = self.run_cmd(default + ['ps', '-q', 'app']).stdout.strip()
            self.assertEqual(self.run_cmd(['docker', 'inspect', '--format', '{{.Image}}', app]).stdout.strip(), new)
            self.assertEqual(self.run_cmd(['docker', 'image', 'inspect', '--format', '{{.Id}}', 'letterdock-candidate:' + run]).stdout.strip(), new)
        self.assertEqual((self.live / '.env').read_text().count('POSTGRES_PASSWORD='), 1)
        # A failed cutover must not publish its image as the default.
        published_before = (self.live / 'compose.override.yml').read_bytes()
        (self.candidate / 'node').write_text('#!/bin/sh\nexit 1\n')
        bad_run = str(int(time.time() * 1000000)) + '-1'
        failed = subprocess.run(['bash', str(SCRIPT), str(self.live), str(self.candidate), SHA,
                                 'owner/repo', bad_run], input='fixture-token\n', cwd=self.live,
                                env=self.env, text=True, capture_output=True, timeout=180)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn('Health check failed', failed.stderr)
        self.assertTrue(Path(str(self.live) + '.deploy-needs-review').exists())
        failed_model = json.loads(self.run_cmd(default + ['config', '--format', 'json']).stdout)
        self.assertEqual(failed_model['services']['app']['image'], 'letterdock-candidate:' + run)
        self.assertEqual((self.live / 'compose.override.yml').read_bytes(), published_before)
        blocked = subprocess.run(['bash', str(SCRIPT), str(self.live), str(self.candidate), SHA,
                                  'owner/repo', bad_run], input='fixture-token\n', cwd=self.live,
                                 env=self.env, text=True, capture_output=True, timeout=30)
        self.assertIn('Previous cutover needs operator review', blocked.stderr)
        # Reset only this disposable fixture; real recovery must assess schema safety.
        Path(str(self.live) + '.deploy-needs-review').unlink()
        self.run_cmd(default + ['up', '-d', '--build'])
        (self.candidate / 'node').write_text('#!/bin/sh\nexit 0\n# interrupted candidate\n')
        (self.bin / 'sudo').write_text("""#!/bin/sh
case " $* " in
  *" up -d --no-deps --no-build app "*)
    "$@" || exit $?
    kill -KILL "$PPID"
    exit 1;;
esac
exec "$@"
""")
        interrupted_run = str(int(time.time() * 1000000)) + '-1'
        interrupted = subprocess.run(['bash', str(SCRIPT), str(self.live), str(self.candidate), SHA,
                                       'owner/repo', interrupted_run], input='fixture-token\n',
                                      cwd=self.live, env=self.env, text=True, capture_output=True, timeout=180)
        self.assertNotEqual(interrupted.returncode, 0)
        self.assertTrue(Path(str(self.live) + '.deploy-needs-review').exists())
        self.assertEqual((self.live / 'compose.override.yml').read_bytes(), published_before)
        app = self.run_cmd(default + ['ps', '-q', 'app']).stdout.strip()
        running = self.run_cmd(['docker', 'inspect', '--format', '{{.Image}}', app]).stdout.strip()
        interrupted_image = self.run_cmd(['docker', 'image', 'inspect', '--format', '{{.Id}}',
                                          'letterdock-candidate:' + interrupted_run]).stdout.strip()
        self.assertEqual(running, interrupted_image)
        self.assertNotEqual(running, new)
        self.cleanup_project()


if __name__ == '__main__': unittest.main()
