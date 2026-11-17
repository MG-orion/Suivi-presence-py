"""Service de planning : sessions (date, horaires, matière, salle, formateur). Port 4002."""
import os, re, secrets, sqlite3
from datetime import datetime
from zoneinfo import ZoneInfo
from fastapi import Request
from fastapi.responses import JSONResponse
from common.http import ApiError, auth, body_of, call, make_app

TZ = ZoneInfo(os.environ.get("TZ") or "Europe/Paris")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def open_db(path: str) -> sqlite3.Connection:
    if path != ":memory:":
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    db = sqlite3.connect(path, check_same_thread=False)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode = WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, date TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
        subject TEXT NOT NULL, room TEXT NOT NULL DEFAULT '',
        trainer_id TEXT, trainer_name TEXT NOT NULL DEFAULT '')""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_sessions_date ON sessions(date, start)")
    db.commit()
    return db


def to_ms(date: str, hhmm: str) -> int:
    """Instant en millisecondes, heure locale de l'établissement."""
    d = datetime.strptime(f"{date} {hhmm}", "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    return int(d.timestamp() * 1000)


def dto(s) -> dict:
    return {"id": s["id"], "date": s["date"], "start": s["start"], "end": s["end"],
            "subject": s["subject"], "room": s["room"],
            "trainerId": s["trainer_id"], "trainerName": s["trainer_name"],
            "startMs": to_ms(s["date"], s["start"]), "endMs": to_ms(s["date"], s["end"])}


def create_app(db, urls):
    app = make_app("planning")

    @app.get("/sessions")
    async def sessions(request: Request):
        auth(request, "student", "trainer", "admin")
        return [dto(s) for s in db.execute("SELECT * FROM sessions ORDER BY date, start").fetchall()]

    @app.post("/sessions")
    async def create_session(request: Request):
        auth(request, "admin")
        b = await body_of(request)
        t = lambda v, n: v.strip()[:n] if isinstance(v, str) else ""
        d = {"date": t(b.get("date"), 10), "start": t(b.get("start"), 5), "end": t(b.get("end"), 5),
             "subject": t(b.get("subject"), 120), "room": t(b.get("room"), 40)}
        if not d["subject"]:
            raise ApiError(400, "Renseignez la matière.")
        if not (DATE_RE.match(d["date"]) and TIME_RE.match(d["start"]) and TIME_RE.match(d["end"])):
            raise ApiError(400, "Date ou horaires invalides.")
        try:
            datetime.strptime(d["date"], "%Y-%m-%d")
        except ValueError:
            raise ApiError(400, "Date ou horaires invalides.")
        if d["end"] <= d["start"]:
            raise ApiError(400, "L'heure de fin doit être après l'heure de début.")
        trainer_id, trainer_name = None, ""
        if b.get("trainerId"):
            try:
                u = await call(urls["auth"], "/internal/users/" + str(b["trainerId"]))
            except ApiError as e:
                if e.status == 404:
                    raise ApiError(400, "Formateur introuvable.")
                raise
            if u["role"] != "trainer":
                raise ApiError(400, "Ce compte n'est pas un formateur.")
            trainer_id, trainer_name = u["id"], f"{u['first']} {u['name']}"
        sid = "ses_" + secrets.token_hex(5)
        with db:
            db.execute("INSERT INTO sessions (id,date,start,end,subject,room,trainer_id,trainer_name) VALUES (?,?,?,?,?,?,?,?)",
                       (sid, d["date"], d["start"], d["end"], d["subject"], d["room"], trainer_id, trainer_name))
        row = db.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
        return JSONResponse(dto(row), status_code=201)

    @app.delete("/sessions/{sid}")
    async def delete_session(request: Request):
        auth(request, "admin")
        sid = request.path_params["sid"]
        with db:
            n = db.execute("DELETE FROM sessions WHERE id = ?", (sid,)).rowcount
        if not n:
            raise ApiError(404, "Session introuvable.")
        try:
            await call(urls["attendance"], f"/internal/sessions/{sid}/purge", "POST", {})
        except ApiError as e:
            print("[planning] nettoyage différé :", e.message)
        return {"ok": True}

    # Routes internes
    @app.get("/internal/sessions/{sid}")
    async def internal_session(request: Request):
        auth(request, "service")
        s = db.execute("SELECT * FROM sessions WHERE id = ?", (request.path_params["sid"],)).fetchone()
        if not s:
            raise ApiError(404, "Session introuvable.")
        return dto(s)

    @app.post("/internal/trainers/{tid}/unassign")
    async def unassign(request: Request):
        auth(request, "service")
        with db:
            db.execute("UPDATE sessions SET trainer_id = NULL WHERE trainer_id = ?", (request.path_params["tid"],))
        return {"ok": True}

    return app


def main():
    import uvicorn
    port = int(os.environ.get("PORT", 4002))
    db = open_db(os.path.join(os.environ.get("DATA_DIR", "data"), "planning.db"))
    app = create_app(db, {"auth": os.environ.get("AUTH_URL", "http://localhost:4001"),
                          "attendance": os.environ.get("ATTENDANCE_URL", "http://localhost:4003")})
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")


if __name__ == "__main__":
    main()
