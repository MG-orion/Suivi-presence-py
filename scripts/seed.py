"""Données de démonstration : 1 admin, 2 formateurs, 30 étudiants, ~6 semaines de sessions.
Usage : python -m scripts.seed   (base vide uniquement)"""
import os, random, secrets, sys, unicodedata
from datetime import date, datetime, timedelta, timezone
from services import attendance, auth, planning

d = os.environ.get("DATA_DIR", "data")
adb = auth.open_db(os.path.join(d, "auth.db"))
if adb.execute("SELECT COUNT(*) FROM users").fetchone()[0]:
    sys.exit("Base déjà remplie : supprimez le dossier data pour repartir de zéro.")
pdb = planning.open_db(os.path.join(d, "planning.db"))
tdb = attendance.open_db(os.path.join(d, "attendance.db"))

PW = "demo1234"
auth.insert_user(adb, "admin@ecole.test", PW, "admin", "Claire", "Martin", id="u_admin")
trainers = [("u_t1", "formateur1@ecole.test", "Hugo", "Bernard"), ("u_t2", "formateur2@ecole.test", "Sarah", "Lefèvre")]
for id_, em, f, n in trainers:
    auth.insert_user(adb, em, PW, "trainer", f, n, id=id_)
firsts = "Léa Lucas Emma Noah Chloé Louis Inès Jules Manon Adam Camille Nathan Sofia Tom Zoé Maël Jade Enzo Lina Ethan Alice Rayan Eva Théo Nina Yanis Clara Paul Anaïs Sacha".split()
lasts = "Dubois Moreau Laurent Simon Michel Garcia David Roux Vincent Fournier Morel Girard André Mercier Blanc Guérin Boyer Garnier Chevalier François Legrand Gauthier Perrin Robin Clément Morin Nicolas Henry Masson Rousseau".split()
ascii_ = lambda s: "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn").lower()
students = []
for i, (f, n) in enumerate(zip(firsts, lasts), 1):
    sid = f"u_s{i:02d}"
    students.append(sid)
    auth.insert_user(adb, f"{ascii_(f)}.{ascii_(n)}@ecole.test", PW, "student", f, n, id=sid)

subjects = [("Algorithmique", "B12"), ("Base de données", "B14"), ("Réseaux", "A03"), ("Développement web", "B12"), ("Anglais technique", "A07")]
slots = [("08:30", "10:30"), ("10:45", "12:45"), ("14:00", "16:00"), ("16:15", "17:45")]
weak = {"u_s04", "u_s11", "u_s23"}
today = date.today()
n = 0
now_ms = datetime.now().timestamp() * 1000
with pdb, tdb:
    for off in range(-35, 8):
        day = today + timedelta(days=off)
        if day.weekday() >= 5:
            continue
        n += 1
        for k in range(2 + n % 2):
            start, end = slots[(k + (off & 1)) % len(slots)]
            subj, room = subjects[(n + k) % len(subjects)]
            tid, _, tf, tn = trainers[(n + k) % 2]
            sid = "ses_" + secrets.token_hex(5)
            pdb.execute("INSERT INTO sessions (id,date,start,end,subject,room,trainer_id,trainer_name) VALUES (?,?,?,?,?,?,?,?)",
                        (sid, day.isoformat(), start, end, subj, room, tid, f"{tf} {tn}"))
            start_ms = planning.to_ms(day.isoformat(), start)
            if start_ms + 3 * 3600000 < now_ms:  # sessions passées : clôturées avec pointages
                tdb.execute("INSERT INTO session_state (session_id,status,seed,opened_at) VALUES (?,?,?,?)",
                            (sid, "closed", secrets.token_hex(8), datetime.fromtimestamp((start_ms - 600000) / 1000, timezone.utc).isoformat()))
                for stu in students:
                    r = random.random()
                    pa, pl = (0.35, 0.15) if stu in weak else (0.025, 0.06)
                    st = "A" if r < pa else "R" if r < pa + pl else "P"
                    m = "auto" if st == "A" else random.choice(["qr", "signature", "manual"])
                    at = datetime.fromtimestamp((start_ms + (9 if st == "R" else 2) * 60000) / 1000, timezone.utc).isoformat()
                    tdb.execute("INSERT INTO marks (session_id,student_id,status,method,at) VALUES (?,?,?,?,?)", (sid, stu, st, m, at))
print(f"Données de démonstration créées.\nComptes (mot de passe : {PW}) :\n  admin@ecole.test\n  formateur1@ecole.test\n  {ascii_(firsts[0])}.{ascii_(lasts[0])}@ecole.test")
