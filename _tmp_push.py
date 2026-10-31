"""通过 GitHub Git Data API 推送当前工作树（本机 git push 到 github.com 不通）。"""
import base64
import json
import subprocess
import sys

OWNER, REPO, BRANCH, MESSAGE_FILE = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
MESSAGE = open(MESSAGE_FILE, encoding='utf-8').read()


def gh(path, payload=None, method=None):
    if payload is None and method is None:
        result = subprocess.run(['gh', 'api', path], capture_output=True, text=True)
    else:
        cmd = ['gh', 'api']
        if method:
            cmd += ['-X', method]
        cmd.append(path)
        cmd += ['--input', '-']
        result = subprocess.run(cmd, input=json.dumps(payload), capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f'{path}: {result.stderr.strip()[:400]}')
    return json.loads(result.stdout) if result.stdout.strip() else {}


parent = gh(f'repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}')['object']['sha']
print('parent:', parent[:7])

files = subprocess.run(['git', 'ls-files'], capture_output=True, text=True).stdout.split()
entries = []
for path in files:
    with open(path, 'rb') as handle:
        data = handle.read()
    blob = gh(f'repos/{OWNER}/{REPO}/git/blobs', {
        'content': base64.b64encode(data).decode('ascii'),
        'encoding': 'base64',
    })
    entries.append({'path': path.replace('\\', '/'), 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})

tree = gh(f'repos/{OWNER}/{REPO}/git/trees', {'tree': entries})
commit = gh(f'repos/{OWNER}/{REPO}/git/commits', {
    'message': MESSAGE,
    'tree': tree['sha'],
    'parents': [parent],
})
gh(f'repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}', {'sha': commit['sha'], 'force': True}, method='PATCH')
print('commit:', commit['sha'], 'files:', len(entries))
