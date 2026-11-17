import socket, threading, time
from datetime import datetime, timedelta
import httpx, pytest, uvicorn
from services import attendance, auth, gateway, planning
from services.attendance import check_code, code_for, point_state


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Srv:
    def __init__(self, app, port):
        self.server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self):
        self.thread.start()
        for _ in range(200):
            if self.server.started: return
            time.sleep(0.02)
        raise RuntimeError("serveur non démarré")

    def stop(self):
        self.server.should_exit = True; self.thread.join(5)


def test_regles_pures():
    t0, m = 1_000_000_000_000, 60000
    assert not point_state("planned", t0, t0)[0]
    assert not point_state("closed", t0, t0)[0]
    assert not point_state("open", t0, t0 - 16 * m)[0]
    assert point_state("open", t0, t0 - 10 * m)[1] == "P"
    assert point_state("open", t0, t0 + 5 * m)[1] == "P"
    assert point_state("open", t0, t0 + 6 * m)[1] == "R"
    assert point_state("open", t0, t0 + 15 * m)[1] == "R"
    assert not point_state("open", t0, t0 + 16 * m)[0]
    now = time.time() * 1000
    c = code_for("seed", int(now // 60000))
    assert check_code("seed", c, now)
    assert check_code("seed", c, now + 60000)        # tranche précédente tolérée
    assert not check_code("seed", c, now + 125000)
    assert not check_code("autre", c, now)


@pytest.fixture(scope="module")
def stack():
    urls = {}
    adb, pdb, tdb = auth.open_db(":memory:"), planning.open_db(":memory:"), attendance.open_db(":memory:")
    for id_, em, pw, role, f, n in [("a1", "admin@x.fr", "adminpass1", "admin", "A", "Admin"),
                                    ("t1", "tr@x.fr", "trainerpass1", "trainer", "T", "Trainer"),
                                    ("t2", "tr2@x.fr", "trainerpass2", "trainer", "U", "Autre"),
                                    ("s1", "s1@x.fr", "studentpass1", "student", "S", "Un"),
                                    ("s2", "s2@x.fr", "studentpass2", "student", "S", "Deux")]:
        auth.insert_user(adb, em, pw, role, f, n, id=id_)
    ports = [free_port() for _ in range(4)]
    urls.update(auth=f"http://127.0.0.1:{ports[0]}", planning=f"http://127.0.0.1:{ports[1]}",
                attendance=f"http://127.0.0.1:{ports[2]}")
    srvs = [Srv(auth.create_app(adb, urls), ports[0]), Srv(planning.create_app(pdb, urls), ports[1]),
            Srv(attendance.create_app(tdb, urls), ports[2]),
            Srv(gateway.create_app(urls, introspect_s=0), ports[3])]
    for s in srvs: s.start()
    yield {"base": f"http://127.0.0.1:{ports[3]}", "adb": adb, "pdb": pdb, "tdb": tdb}
    for s in srvs: s.stop()


def test_parcours_complet(stack):
    base, pdb, tdb = stack["base"], stack["pdb"], stack["tdb"]

    def client():
        c = httpx.Client(base_url=base, headers={"X-Presence": "1"}, timeout=10)
        return c

    def login(email, pw):
        c = client()
        r = c.post("/api/login", json={"email": email, "password": pw})
        assert r.status_code == 200, (email, r.text)
        return c

    anon = client()
    assert anon.get("/api/bootstrap").status_code == 401
    assert anon.post("/api/login", json={"email": "admin@x.fr", "password": "faux"}).status_code == 401
    r0 = anon.post("/api/login", json={"email": "admin@x.fr", "password": "adminpass1"})
    assert "httponly" in r0.headers["set-cookie"].lower()
    assert "token" not in r0.text
    assert httpx.post(base + "/api/logout").status_code == 403          # CSRF : en-tête manquant
    assert "frame-ancestors 'none'" in r0.headers["content-security-policy"]

    admin, trainer = login("admin@x.fr", "adminpass1"), login("tr@x.fr", "trainerpass1")
    trainer2, s1, s2 = login("tr2@x.fr", "trainerpass2"), login("s1@x.fr", "studentpass1"), login("s2@x.fr", "studentpass2")

    def mk(min_ago, subject):
        d = datetime.now() - timedelta(minutes=min_ago)
        r = admin.post("/api/sessions", json={"date": d.strftime("%Y-%m-%d"), "start": d.strftime("%H:%M"),
                                              "end": "23:59", "subject": subject, "room": "A1", "trainerId": "t1"})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    sa, sb = mk(1, "Algo"), mk(8, "Réseaux")
    assert s1.post("/api/sessions", json={"date": "2026-01-01", "start": "08:00", "end": "09:00", "subject": "x"}).status_code == 403
    assert admin.post("/api/sessions", json={"date": "2026-01-01", "start": "10:00", "end": "09:00", "subject": "x"}).status_code == 400

    assert s1.post(f"/api/sessions/{sa}/point", json={"method": "qr", "code": "000000"}).status_code == 403  # pas ouvert
    assert trainer2.post(f"/api/sessions/{sa}/open").status_code == 403      # pas son formateur
    assert s1.post(f"/api/sessions/{sa}/open").status_code == 403
    assert trainer.post(f"/api/sessions/{sa}/open").status_code == 200
    trainer.post(f"/api/sessions/{sb}/open")

    code = trainer.get(f"/api/sessions/{sa}/code").json()
    assert len(code["code"]) == 6 and code["payload"] == f"PRESENCE:{sa}:{code['code']}"
    assert s1.get(f"/api/sessions/{sa}/code").status_code == 403

    bad = "222222" if code["code"] == "111111" else "111111"
    assert s1.post(f"/api/sessions/{sa}/point", json={"method": "qr", "code": bad}).status_code == 403
    ok = s1.post(f"/api/sessions/{sa}/point", json={"method": "qr", "code": code["code"]})
    assert ok.status_code == 201 and ok.json()["status"] == "P"
    assert s1.post(f"/api/sessions/{sa}/point", json={"method": "qr", "code": code["code"]}).status_code == 409

    sig = "M 10 10 L 20 30 L 50 60 L 90 40"
    assert s2.post(f"/api/sessions/{sb}/point", json={"method": "signature", "sig": "<script>"}).status_code == 400
    late = s2.post(f"/api/sessions/{sb}/point", json={"method": "signature", "sig": sig})
    assert late.status_code == 201 and late.json()["status"] == "R"     # 8 min après le début : retard

    assert trainer.get(f"/api/sessions/{sb}/signatures").json()["s2"] == sig
    assert s1.get(f"/api/sessions/{sb}/signatures").status_code == 403

    assert trainer.put(f"/api/sessions/{sa}/marks/s2", json={"s": "X"}).status_code == 400
    assert trainer.put(f"/api/sessions/{sa}/marks/s2", json={"s": "P"}).status_code == 200
    assert trainer.put(f"/api/sessions/{sa}/marks/t1", json={"s": "P"}).status_code == 404

    assert trainer.post(f"/api/sessions/{sb}/close").status_code == 200
    assert s1.post(f"/api/sessions/{sb}/point", json={"method": "qr", "code": "123456"}).status_code == 409
    boot = s1.get("/api/bootstrap").json()
    assert boot["me"]["role"] == "student" and len(boot["students"]) == 1 and boot["trainers"] == []
    sB = next(s for s in boot["sessions"] if s["id"] == sb)
    assert sB["status"] == "closed" and sB["marks"]["s1"] == {**sB["marks"]["s1"], "s": "A", "m": "auto"}
    assert "s2" not in sB["marks"]          # un étudiant ne voit pas les présences des autres

    assert s1.post("/api/justifs", json={"sessionId": sa, "reason": "Rendez-vous médical"}).status_code == 400
    assert s1.post("/api/justifs", json={"sessionId": sb, "reason": "ok"}).status_code == 400
    j = s1.post("/api/justifs", json={"sessionId": sb, "reason": "Rendez-vous médical"})
    assert j.status_code == 201
    assert s1.post("/api/justifs", json={"sessionId": sb, "reason": "Rendez-vous médical"}).status_code == 409
    assert trainer.put(f"/api/justifs/{j.json()['id']}", json={"status": "validated"}).status_code == 403
    assert admin.put(f"/api/justifs/{j.json()['id']}", json={"status": "validated"}).status_code == 200
    assert admin.put(f"/api/justifs/{j.json()['id']}", json={"status": "refused"}).status_code == 409
    boot = s1.get("/api/bootstrap").json()
    assert next(s for s in boot["sessions"] if s["id"] == sb)["marks"]["s1"]["s"] == "J"
    assert boot["justifs"][0]["status"] == "validated"

    tb, ab = trainer.get("/api/bootstrap").json(), admin.get("/api/bootstrap").json()
    assert len(tb["students"]) == 2 and len(tb["trainers"]) == 1 and len(ab["trainers"]) == 2
    assert ab["rules"]["thresh"] == 0.8

    created = admin.post("/api/users", json={"first": "Nou", "name": "Veau", "email": "nv@x.fr", "role": "student"})
    assert created.status_code == 201 and len(created.json()["tempPassword"]) >= 10
    assert admin.post("/api/users", json={"first": "Nou", "name": "Veau", "email": "NV@x.fr", "role": "student"}).status_code == 409
    login("nv@x.fr", created.json()["tempPassword"])
    assert s1.post("/api/users", json={"first": "a", "name": "b", "email": "c@d.fr", "role": "admin"}).status_code == 403
    assert admin.post("/api/users", json={"first": "a", "name": "b", "email": "c@d.fr", "role": "admin"}).status_code == 400

    old = client(); old.post("/api/login", json={"email": "s2@x.fr", "password": "studentpass2"})
    assert s2.post("/api/password", json={"old": "faux", "new": "nouveaumdp1"}).status_code == 403
    assert s2.post("/api/password", json={"old": "studentpass2", "new": "court"}).status_code == 400
    assert s2.post("/api/password", json={"old": "studentpass2", "new": "nouveaumdp1"}).status_code == 200
    assert s2.get("/api/bootstrap").status_code == 200        # cookie renouvelé
    assert old.get("/api/bootstrap").status_code == 401       # ancien jeton révoqué

    assert admin.delete("/api/users/a1").status_code == 400
    assert admin.delete("/api/users/s2").status_code == 200
    assert tdb.execute("SELECT COUNT(*) FROM marks WHERE student_id = 's2'").fetchone()[0] == 0
    assert s2.get("/api/bootstrap").status_code == 401        # compte supprimé
    assert admin.delete("/api/users/t1").status_code == 200
    assert pdb.execute("SELECT trainer_id FROM sessions WHERE id = ?", (sa,)).fetchone()[0] is None

    assert admin.delete(f"/api/sessions/{sb}").status_code == 200
    assert tdb.execute("SELECT COUNT(*) FROM marks WHERE session_id = ?", (sb,)).fetchone()[0] == 0
    assert tdb.execute("SELECT COUNT(*) FROM justifs WHERE session_id = ?", (sb,)).fetchone()[0] == 0
    assert admin.post("/api/logout").status_code == 200

    assert httpx.get(base + "/").status_code == 200          # le front est servi
    assert httpx.get(base + "/app.js").status_code == 200
