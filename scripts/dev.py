"""Lance les 4 processus (auth, planning, attendance, gateway) pour le développement local."""
import os, secrets, signal, subprocess, sys, time

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data = os.path.abspath(os.environ.get("DATA_DIR") or os.path.join(root, "data"))
os.makedirs(data, exist_ok=True)
secret = os.environ.get("JWT_SECRET")
if not secret:
    f = os.path.join(data, ".jwt_secret")
    if not os.path.exists(f):
        with open(os.open(f, os.O_WRONLY | os.O_CREAT, 0o600), "w") as fh:
            fh.write(secrets.token_hex(32))
    secret = open(f).read().strip()
env = {**os.environ, "JWT_SECRET": secret, "DATA_DIR": data}
procs = [subprocess.Popen([sys.executable, "-m", f"services.{m}"], cwd=root, env=env)
         for m in ("auth", "planning", "attendance", "gateway")]


def stop(*_):
    for p in procs:
        p.terminate()
    sys.exit(0)


signal.signal(signal.SIGINT, stop)
signal.signal(signal.SIGTERM, stop)
print("Application : http://localhost:3000  (Ctrl+C pour arrêter)")
while all(p.poll() is None for p in procs):
    time.sleep(1)
stop()
