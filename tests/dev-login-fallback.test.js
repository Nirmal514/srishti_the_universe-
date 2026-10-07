const assert = require('assert');
const { spawn } = require('child_process');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname + '/..',
    env: {
      ...process.env,
      PORT: '3456',
      GOOGLE_CLIENT_ID: 'example-client-id.apps.googleusercontent.com',
      DEV_LOGIN: '1',
      ALLOWED_EMAILS: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  child.stdout.on('data', (d) => { logs += d.toString(); });
  child.stderr.on('data', (d) => { logs += d.toString(); });

  try {
    await wait(1000);

    const cfg = await fetch('http://localhost:3456/api/config', { headers: { 'x-requested-with': 'shrishti' } })
      .then((r) => r.json());
    assert.strictEqual(cfg.devLogin, true, 'devLogin should be enabled when DEV_LOGIN=1');

    const auth = await fetch('http://localhost:3456/api/auth/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'shrishti' },
      body: JSON.stringify({ name: 'Local Tester' })
    });
    assert.strictEqual(auth.status, 200, `Expected dev login to succeed, got ${auth.status}`);
    const result = await auth.json();
    assert.ok(result && result.name === 'Local Tester', 'Expected dev login response to include a name');
    assert.ok(auth.headers.get('set-cookie') && auth.headers.get('set-cookie').includes('sid='), 'Expected session cookie to be set');

    console.log('DEV_LOGIN fallback test passed');
  } finally {
    child.kill('SIGTERM');
    await wait(200);
  }
}

main().catch((err) => {
  console.error(err.stack || err);
  process.exit(1);
});
