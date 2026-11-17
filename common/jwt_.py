"""JWT HS256 minimal (bibliothèque standard uniquement)."""
import base64, hashlib, hmac, json, time


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sig(data: str, secret: str) -> str:
    return _b64(hmac.new(secret.encode(), data.encode(), hashlib.sha256).digest())


def sign(payload: dict, secret: str, ttl_sec: int) -> str:
    now = int(time.time())
    head = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64(json.dumps({**payload, "iat": now, "exp": now + ttl_sec}, separators=(",", ":")).encode())
    return f"{head}.{body}.{_sig(head + '.' + body, secret)}"


def verify(token, secret: str):
    """Retourne la charge utile, ou None si le jeton est absent, falsifié ou expiré."""
    try:
        head, body, sig = str(token).split(".")
        if json.loads(_unb64(head)).get("alg") != "HS256":
            return None
        if not hmac.compare_digest(sig, _sig(head + "." + body, secret)):
            return None
        p = json.loads(_unb64(body))
        return p if p.get("exp", 0) > time.time() else None
    except Exception:
        return None
