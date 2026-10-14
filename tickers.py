"""Curated IDX stocks (code → name) for autocomplete.

Not the whole exchange: liquid, widely followed stocks across sectors. The
larger screener universe is SCREEN_UNIVERSE in app.py.
"""

# ============================================================
# SECTORS & STOCKS (Sorted alphabetically by sector, then ticker)
# ============================================================

IDX = {
    # --- Financial Services ---
    # Banks
    "BBCA": "Bank Central Asia",
    "BBRI": "Bank Rakyat Indonesia",
    "BMRI": "Bank Mandiri",
    "BBNI": "Bank Negara Indonesia",
    "BRIS": "Bank Syariah Indonesia",
    "BBTN": "Bank Tabungan Negara",
    "ARTO": "Bank Jago",
    "BBHI": "Allo Bank",
    "BNGA": "Bank CIMB Niaga",
    "BTPS": "BTPN Syariah",
    "BJBR": "Bank BJB",
    "BJTM": "Bank Pembangunan Daerah Jawa Timur",
    "PNBN": "Bank Pan Indonesia",
    "MEGA": "Bank Mega",

    # Non-Bank Financial
    "PNLF": "Panin Financial",
    "BFIN": "BFI Finance",
    "BBKP": "Bank KB Bukopin",
    "AGRO": "Bank Raya",

    # --- telecommunications & Technology ---
    "TLKM": "Telkom Indonesia",
    "ISAT": "Indosat",
    "EXCL": "XL Axiata",
    "TOWR": "Sarana Menara Nusantara",
    "MTEL": "Mitratel",
    "TBIG": "Tower Bersama Infrastructure",
    "GOTO": "GoTo Gojek Tokopedia",
    "BUKA": "Bukalapak",
    "EMTK": "Elang Mahkota Teknologi",
    "MLPT": "Multipolar Technology",
    "DCII": "DCI Indonesia",
    "WIFI": "Solusi Sinergi Digital",

    # --- Consumer Goods ---
    # Food & Beverages
    "UNVR": "Unilever Indonesia",
    "ICBP": "Indofood CBP Sukses Makmur",
    "INDF": "Indofood Sukses Makmur",
    "MYOR": "Mayora Indah",
    "GGRM": "Gudang Garam",
    "HMSP": "HM Sampoerna",
    "ULTJ": "Ultrajaya Steel Industry",
    "ROTI": "Nippon Indosari Corpindo",
    "SIDO": "Sido Muncul",

    # Retail & Distribution
    "AMRT": "Sumber Alfaria Trijaya",
    "MAPA": "Map Aktif Adiperkasa",
    "ACES": "Ace Hardware Indonesia",
    "ERAA": "Erajaya Swasembada",
    "RALS": "Ramayana Lestari Sentosa",
    "LPPF": "Matahari Department Store",
    "MAPI": "Mitra Adiperkasa",

    # Consumer Durables & Others
    "CPIN": "Charoen Pokphand Indonesia",
    "JPFA": "Japfa Comfeed Indonesia",
    "KLBF": "Kalbe Farma",
    "KAEF": "Kimia Farma",
    "INAF": "Indofarma",
    "HEAL": "Medikaloka Hermina",
    "SILO": "Siloam Hospitals",
    "SAME": "Sarana Meditama Nusantara",
    "MIKA": "Mitra Keluarga Karyasehat",
    "PRDA": "Prodia Widyahusada",

    # --- Energy & Mining ---
    # Coal & Mining
    "ADRO": "Adaro Energy Indonesia",
    "PTBA": "Bukit Asam",
    "ITMG": "Indo Tambangraya Megah",
    "HRUM": "Harum Energy",
    "INDY": "Indika Energy",
    "TINS": "Timah",
    "ANTM": "Aneka Tambang",
    "INCO": "Vale Indonesia",
    "GEMS": "Golden Energy Mines",
    "BUMI": "Bumi Resources",
    "BRMS": "Bumi Resources Minerals",
    "MDKA": "Merdeka Copper Gold",

    # Oil & Gas
    "PGAS": "PGN Nusantara Gas",
    "MEDC": "Medco Energi Internasional",
    "AKRA": "AKR Corporindo",
    "ELSA": "Elnusa",
    "RAJA": "Rukun Raharja",
    "PGEO": "Pertamina Geothermal Energy",
    "RATU": "Raharja Energi Cepu",

    # --- Industrial & Automotive ---
    "ASII": "Astra International",
    "UNTR": "United Tractors",
    "AUTO": "Astra Otoparts",
    "GJTL": "Gajah Tunggal",
    "MASA": "Multistrada Arah Sarana",

    # Cement & Building Materials
    "SMGR": "Semen Indonesia",
    "INTP": "Indocement Tunggal Prakarsa",
    "INKP": "Indah Kiat Pulp & Paper",
    "TKIM": "Pabrik Kertas Tjiwi Kimia",
    "SMBR": "Semen Baturaja",
    "ARNA": "Arwana Citramulia",

    # Infrastructure & Property
    "JSMR": "Jasa Marga",
    "WIKA": "Wijaya Karya",
    "PTPP": "PP Presisi",
    "ADHI": "Adhi Karya",
    "WTON": "Wijaya Karya Beton",
    "WSKT": "Waskita Karya",

    # Property
    "BSDE": "Bumi Serpong Damai",
    "CTRA": "Ciputra Development",
    "PWON": "Pakuwon Jati",
    "SMRA": "Summarecon Agung",
    "ASRI": "Alam Sutra Realty",
    "APLN": "Agung Podomoro Land",
    "DMAS": "Puradelta Lestari",
    "BEST": "Bekasi Fajar Industrial Estate",

    # --- Petrochemicals & Chemicals ---
    "BRPT": "Barito Pacific",
    "TPIA": "Chandra Asri Petrochemical",
    "ESSA": "ESSA Industries Indonesia",
    "AVIA": "Avia Avian",

    # --- Media & Entertainment ---
    "SCMA": "Surya Citra Media",
    "MNCN": "Media Nusantara Citra",
    "FILM": "MD Pictures",
    "CMRY": "Cisarua Mountain Dairy",

    # --- Agriculture ---
    "AALI": "Astra Agro Lestari",
    "SSMS": "Sawit Sumbermas Sarana",
    "LSIP": "PP London Sumatra",
    "TAPG": "Triputra Agro Persada",
    "DSNG": "Dharma Satya Nusantara",

    # --- Trade & Manufacturing ---
    "SRIL": "Sri Rejeki Isman",
    "POLL": "Pollux Investment Indonesia",
    "DEWA": "Darma Henwa",
    "ENRG": "Energi Mega Persada",
    "PTRO": "Petrosea",

    # --- Renewable Energy & Utilities ---
    "BREN": "Barito Renewables",
    "CUAN": "Petrindo Jaya Kreasi",
}


def search_tickers(query: str, limit: int = 10) -> list:
    """
    Search tickers by symbol or name.
    Returns list of dicts with 'symbol' and 'name'.
    """
    q = query.lower().strip()
    if not q:
        return []

    starts = []
    contains = []

    for sym, name in IDX.items():
        sl, nl = sym.lower(), name.lower()
        if sl.startswith(q) or nl.startswith(q):
            starts.append({"symbol": sym, "name": name})
        elif q in sl or q in nl:
            contains.append({"symbol": sym, "name": name})

    return (starts + contains)[:limit]
