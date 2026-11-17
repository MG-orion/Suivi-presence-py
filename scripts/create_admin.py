"""Usage : python -m scripts.create_admin email prenom nom [motdepasse]"""
import os, sys
from common.passwords import temp_password
from services.auth import insert_user, open_db

if len(sys.argv) < 4:
    sys.exit("Usage : python -m scripts.create_admin email prenom nom [motdepasse]")
email, first, name = sys.argv[1:4]
password = sys.argv[4] if len(sys.argv) > 4 else temp_password()
if len(password) < 8:
    sys.exit("Mot de passe : 8 caractères minimum.")
db = open_db(os.path.join(os.environ.get("DATA_DIR", "data"), "auth.db"))
insert_user(db, email, password, "admin", first, name)
print(f"Administrateur créé : {email}\nMot de passe : {password}")
