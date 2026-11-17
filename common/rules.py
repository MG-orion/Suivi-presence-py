"""Règles de présence, définies une seule fois pour tous les services."""
RULES = {
    "before": 15,        # minutes avant le début : le pointage ouvre
    "late": 5,           # jusqu'à 5 min après le début : présent
    "after": 15,         # jusqu'à 15 min après le début : retard, ensuite c'est fermé
    "thresh": 0.8,       # seuil d'alerte sur le taux d'assiduité
    "absMax": 3,         # alerte à partir de 3 absences non justifiées
    "lateWeight": 0.5,   # un retard compte pour une demi-présence
    "justifyHours": 48,  # délai de dépôt d'un justificatif
    "qrSeconds": 60,     # durée de validité d'un code
}
