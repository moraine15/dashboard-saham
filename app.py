"""Flask backend for a self-hosted IDX stock and personal-finance dashboard.

Market data comes from yfinance (IDX quotes are delayed about 15 minutes).
Start it with start.bat / start.sh or `python app.py`, which serves with
Waitress and opens http://127.0.0.1:5000. Settings come from the environment
or a .env file next to this file (real environment variables win); see
.env.example for the full list, e.g.:

  FLASK_HOST             127.0.0.1 by default; 0.0.0.0 lets phones on the LAN connect
  FLASK_PORT             5000 by default
  DATA_DIR               where data is stored; ./data by default
  APP_NAME               name for a fresh install (otherwise asked at first setup)
  OWNER_PASSWORD         seeds the owner password on a fresh install (8+ characters)
  MASTER_ADMIN_PASSWORD  administrator password; takes priority over data/admin.json
  SESSION_COOKIE_SECURE  set to 1 only behind HTTPS
"""
from __future__ import annotations

import os
import sys
import json
import time
import math
import hashlib
import io
import secrets
import shutil
import threading
import logging
import datetime as dt
import re
from collections import OrderedDict, defaultdict, deque
from typing import Any, Optional
from urllib.parse import urlsplit

import pandas as pd
import yfinance as yf
from flask import Flask, jsonify, render_template, request, send_file, session
from werkzeug.security import check_password_hash, generate_password_hash

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    stream=sys.stdout
)
logger = logging.getLogger(__name__)

import indicators as ind
import news as news_mod
import ai as ai_mod
from tickers import search_tickers


def _load_env_file(path: str) -> None:
    """Load KEY=VALUE lines from ``path`` without overriding real environment variables."""
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            lines = handle.readlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if key.isidentifier():
            os.environ.setdefault(key, value)


if os.environ.get("SAHAM_DISABLE_DOTENV") != "1":
    _load_env_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

app = Flask(__name__,
            template_folder='templates',
            static_folder='static',
            static_url_path='/static')

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _resolve_data_dir(value: Optional[str]) -> str:
    """DATA_DIR from the environment (relative to the app folder), else ./data."""
    if value and value.strip():
        path = os.path.expanduser(value.strip())
        return path if os.path.isabs(path) else os.path.join(_BASE_DIR, path)
    return os.path.join(_BASE_DIR, "data")


_DATA_DIR = _resolve_data_dir(os.environ.get("DATA_DIR"))
_STATIC_DIR = os.path.join(_BASE_DIR, "static")
os.makedirs(_DATA_DIR, exist_ok=True)

_asset_versions: dict[str, tuple[float, str]] = {}


def _asset_version(name: str) -> str:
    """Return a short content hash for a file in static/, used as its ``?v=``.

    Static files are cached for a week, so the version must change whenever
    the file does. The hash is recomputed only when the file's mtime changes.

    Args:
        name: Path relative to the static folder, e.g. ``"css/tokens.css"``.

    Returns:
        Ten hex characters, or ``"0"`` when the file is missing.
    """
    path = os.path.join(_STATIC_DIR, name)
    try:
        mtime = os.path.getmtime(path)
        cached = _asset_versions.get(path)
        if cached and cached[0] == mtime:
            return cached[1]
        with open(path, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()[:10]
    except OSError:
        return "0"
    _asset_versions[path] = (mtime, digest)
    return digest


app.jinja_env.globals["asset_v"] = _asset_version


def _restrict_permissions(path: str) -> None:
    """Make a private file readable by its owner only (POSIX; Windows keeps folder ACLs)."""
    if os.name != "nt":
        try:
            os.chmod(path, 0o600)
        except OSError:
            logger.warning("Could not restrict permissions on %s", os.path.basename(path))


def _replace_file(tmp: str, path: str) -> None:
    """Move ``tmp`` over ``path``, retrying briefly while Windows has the file open."""
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            break
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(0.05)
    _restrict_permissions(path)


def _persistent_secret() -> str:
    path = os.path.join(_DATA_DIR, "session_secret")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = handle.read().strip()
            if len(value) >= 32:
                return value
    except OSError:
        pass
    value = secrets.token_urlsafe(48)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(value)
        handle.flush()
        os.fsync(handle.fileno())
    _replace_file(tmp, path)
    return value


app.secret_key = os.environ.get("FLASK_SECRET_KEY") or _persistent_secret()
app.config.update(
    MAX_CONTENT_LENGTH=8 * 1024 * 1024,
    SESSION_COOKIE_NAME="saham_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Strict",
    SESSION_COOKIE_SECURE=os.environ.get("SESSION_COOKIE_SECURE", "0") == "1",
    PERMANENT_SESSION_LIFETIME=dt.timedelta(hours=12),
)

# Keep all yfinance SQLite/cookie files in the writable application data directory.
_YF_CACHE_DIR = os.path.join(_DATA_DIR, "cache", "yfinance")
os.makedirs(_YF_CACHE_DIR, exist_ok=True)
try:
    yf.set_tz_cache_location(_YF_CACHE_DIR)
except (AttributeError, OSError):
    logger.warning("This yfinance version cannot change its cache folder")


def _warm_yfinance_caches() -> None:
    """Create yfinance's SQLite caches before requests run in parallel.

    On a fresh data folder, worker threads opening them at the same moment fail
    with "database is locked", and those quotes come back empty.
    """
    try:
        from yfinance import cache as yf_cache
    except ImportError:
        return
    for getter, key in (("get_tz_cache", "WARMUP.JK"), ("get_cookie_cache", "basic"), ("get_isin_cache", "WARMUP")):
        try:
            getattr(yf_cache, getter)().lookup(key)
        except Exception:  # noqa: BLE001 - an older yfinance without this cache works as before
            logger.debug("yfinance cache warm-up skipped: %s", getter, exc_info=True)


_warm_yfinance_caches()

# Windows registries sometimes map .js/.css to the wrong MIME type, which
# breaks script loading under nosniff.
import mimetypes
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/javascript', '.js')

# Administrator password. MASTER_ADMIN_PASSWORD (environment) wins over the
# hash stored in data/admin.json. The environment value is never written to disk.
_ADMIN_PASSWORD_HASH: str | None = None
_ADMIN_SALT: str | None = None
_ADMIN_FROM_ENV = False


def _get_config_file() -> str:
    return os.path.join(_DATA_DIR, "admin.json")


def _load_admin_config() -> dict:
    try:
        with open(_get_config_file(), "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError:
        logger.warning("Admin config file corrupted, resetting")
        return {}
    except Exception as e:
        logger.error(f"Error loading admin config: {e}")
        return {}


def _save_admin_config(config: dict) -> None:
    try:
        os.makedirs(os.path.dirname(_get_config_file()), exist_ok=True)
        tmp = _get_config_file() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        _replace_file(tmp, _get_config_file())
    except Exception as e:
        logger.error(f"Error saving admin config: {e}")


def _init_admin_password() -> None:
    global _ADMIN_PASSWORD_HASH, _ADMIN_SALT, _ADMIN_FROM_ENV

    env_password = os.environ.get("MASTER_ADMIN_PASSWORD", "").strip()
    if env_password and len(env_password) < 8:
        logger.warning("MASTER_ADMIN_PASSWORD ignored: it must be at least 8 characters")
    if env_password and len(env_password) >= 8:
        _ADMIN_SALT = secrets.token_hex(16)
        _ADMIN_PASSWORD_HASH = hashlib.pbkdf2_hmac(
            "sha256", env_password.encode(), _ADMIN_SALT.encode(), 100_000
        ).hex()
        _ADMIN_FROM_ENV = True
        logger.info("Admin password loaded from environment variable")
        return

    _ADMIN_FROM_ENV = False
    config = _load_admin_config()
    if config.get("password_hash") and config.get("salt"):
        # Legacy PBKDF2 record; upgraded to scrypt on the next successful login.
        _ADMIN_PASSWORD_HASH = config["password_hash"]
        _ADMIN_SALT = config["salt"]
        logger.info("Admin password loaded from config file")
        return

    _ADMIN_PASSWORD_HASH = None
    _ADMIN_SALT = None
    if config.get("password"):
        logger.info("Admin password loaded from config file")
    else:
        logger.info("No admin password configured")


def _verify_pbkdf2(password: str) -> bool:
    if not _ADMIN_PASSWORD_HASH or not _ADMIN_SALT:
        return False
    candidate = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), _ADMIN_SALT.encode(), 100_000
    ).hex()
    return secrets.compare_digest(candidate, _ADMIN_PASSWORD_HASH)


def verify_admin_password(password: str) -> bool:
    global _ADMIN_PASSWORD_HASH, _ADMIN_SALT
    if not password:
        return False
    if _ADMIN_FROM_ENV:
        return _verify_pbkdf2(password)
    config = _load_admin_config()
    modern_hash = config.get("password")
    if modern_hash:
        try:
            return check_password_hash(modern_hash, password)
        except (ValueError, TypeError):
            return False
    try:
        valid = _verify_pbkdf2(password)
    except Exception:
        return False
    if valid:
        config["password"] = generate_password_hash(password, method="scrypt")
        config["upgraded_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        config.pop("password_hash", None)
        config.pop("salt", None)
        _save_admin_config(config)
        _ADMIN_PASSWORD_HASH = None
        _ADMIN_SALT = None
    return valid


def is_admin_password_set() -> bool:
    return bool(_ADMIN_FROM_ENV or _ADMIN_PASSWORD_HASH or _load_admin_config().get("password"))


def admin_password_source() -> str | None:
    if _ADMIN_FROM_ENV:
        return "env"
    return "file" if is_admin_password_set() else None


def _write_admin_password(password: str, previous: dict) -> None:
    global _ADMIN_PASSWORD_HASH, _ADMIN_SALT
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    _save_admin_config({
        "password": generate_password_hash(password, method="scrypt"),
        "created_at": previous.get("created_at", now),
        "last_changed": now,
    })
    _ADMIN_PASSWORD_HASH = None
    _ADMIN_SALT = None


def change_admin_password(current_password: str, new_password: str) -> dict:
    """Replace the administrator password after verifying the current one."""
    if _ADMIN_FROM_ENV:
        return {"success": False, "message": "Password administrator diatur lewat MASTER_ADMIN_PASSWORD."}
    if not is_admin_password_set():
        return {"success": False, "message": "Password administrator belum diatur."}
    if not verify_admin_password(current_password):
        return {"success": False, "message": "Password lama salah."}
    if len(new_password) < 8:
        return {"success": False, "message": "Password baru minimal 8 karakter."}
    _write_admin_password(new_password, _load_admin_config())
    logger.info("Admin password changed successfully")
    return {"success": True, "message": "Password administrator diubah."}


_init_admin_password()

# Authentication
_OWNER_FILE = os.path.join(_DATA_DIR, "owner.json")
_LOGIN_ATTEMPTS: dict[str, deque[float]] = defaultdict(deque)
_LOGIN_LOCK = threading.Lock()
_LOGIN_WINDOW = 300
_LOGIN_LIMIT = 8


def _atomic_json(path: str, value: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    _replace_file(tmp, path)


def _load_json(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


_owner_cache: dict[str, Any] = {"path": None, "stamp": None, "value": {}}


def _load_owner_json(path: str) -> dict:
    """Read owner.json; a file that exists but cannot be parsed comes back flagged."""
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            value = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        logger.error("%s cannot be read; first-run setup stays locked", os.path.basename(path))
        return {"_unreadable": True}
    return value if isinstance(value, dict) else {"_unreadable": True}


def _owner_config() -> dict:
    """owner.json, re-read only when its path, size or modification time changes."""
    try:
        info = os.stat(_OWNER_FILE)
    except OSError:
        return {}
    stamp = (info.st_mtime_ns, info.st_size)
    if _owner_cache["path"] != _OWNER_FILE or _owner_cache["stamp"] != stamp:
        _owner_cache.update(path=_OWNER_FILE, stamp=stamp, value=_load_owner_json(_OWNER_FILE))
    return _owner_cache["value"]


def _owner_configured() -> bool:
    """True once an owner password exists, or when owner.json exists but is unreadable.

    Failing closed on a damaged file means first-run setup can never overwrite it.
    """
    config = _owner_config()
    return bool(config.get("password")) or bool(config.get("_unreadable"))


def _verify_owner(password: str) -> bool:
    stored = _owner_config().get("password")
    if not stored or not password:
        return False
    try:
        return check_password_hash(stored, password)
    except (ValueError, TypeError):
        return False


def _credential_generation() -> int:
    value = _owner_config().get("generation", 0)
    return value if isinstance(value, int) else 0


def _set_owner_password(password: str) -> None:
    """Store a new owner password; sessions signed in with the old one stop working."""
    if len(password) < 8:
        raise ValueError("Password pemilik minimal 8 karakter.")
    _atomic_json(_OWNER_FILE, {
        "password": generate_password_hash(password, method="scrypt"),
        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "generation": _credential_generation() + 1,
    })


def _new_csrf() -> str:
    token = secrets.token_urlsafe(32)
    session["csrf"] = token
    return token


def _start_session(role: str) -> str:
    """Sign the current browser in with ``role`` and return its new CSRF token."""
    session.clear()
    session.permanent = True
    session["authenticated"] = True
    session["role"] = role
    session["generation"] = _credential_generation()
    session["login_at"] = time.time()
    return _new_csrf()


def _json_object() -> Optional[dict]:
    """The JSON body as a dict, ``{}`` when there is none, or None when it is not an object."""
    body = request.get_json(silent=True)
    if body is None:
        return {}
    return body if isinstance(body, dict) else None


def _bad_body():
    return jsonify({"error": "Format permintaan tidak valid."}), 400


# App name: chosen at first setup, shown with the fixed credit on every page.
DEFAULT_APP_NAME = "Dashboard Saham"
APP_CREDIT = "by Moraine"
APP_VERSION = "1.0.0"
_APP_FILE = os.path.join(_DATA_DIR, "app.json")
_APP_NAME_MAX = 40
_app_cache: dict[str, Any] = {"path": None, "stamp": None, "value": DEFAULT_APP_NAME}


def _clean_app_name(raw: Any) -> str:
    """Normalise a chosen app name: printable, single-spaced, at most 40 characters.

    Args:
        raw: Anything the user or a config file supplied.

    Returns:
        The cleaned name, or the default when nothing usable is left.
    """
    text = "" if raw is None else str(raw)
    text = "".join(ch if ch.isprintable() else " " for ch in text)
    text = " ".join(text.split())[:_APP_NAME_MAX].strip()
    return text or DEFAULT_APP_NAME


def _app_name() -> str:
    """The app name from app.json, re-read only when the file changes."""
    try:
        info = os.stat(_APP_FILE)
    except OSError:
        return DEFAULT_APP_NAME
    stamp = (info.st_mtime_ns, info.st_size)
    if _app_cache["path"] != _APP_FILE or _app_cache["stamp"] != stamp:
        _app_cache.update(path=_APP_FILE, stamp=stamp,
                          value=_clean_app_name(_load_json(_APP_FILE).get("name")))
    return _app_cache["value"]


def _set_app_name(raw: Any) -> str:
    """Clean and store the app name; returns the stored value."""
    name = _clean_app_name(raw)
    _atomic_json(_APP_FILE, {"name": name, "updated_at": dt.datetime.now(dt.timezone.utc).isoformat()})
    try:
        info = os.stat(_APP_FILE)
        _app_cache.update(path=_APP_FILE, stamp=(info.st_mtime_ns, info.st_size), value=name)
    except OSError:
        pass
    return name


# First-run setup: only on the server computer, and only with the one-time code.
_SETUP: dict[str, Optional[str]] = {"code": None}
_SETUP_LOCK = threading.Lock()
_SETUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_LOOPBACK_ADDRS = frozenset({"127.0.0.1", "::1"})
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_FORWARDING_HEADERS = ("X-Forwarded-For", "Forwarded", "X-Real-IP", "X-Forwarded-Host")


def _setup_code() -> str:
    """The one-time first-run code, created and logged the first time it is needed."""
    with _SETUP_LOCK:
        if not _SETUP["code"]:
            raw = "".join(secrets.choice(_SETUP_ALPHABET) for _ in range(8))
            _SETUP["code"] = f"{raw[:4]}-{raw[4:]}"
            logger.warning("First-run setup code: %s", _SETUP["code"])
        return _SETUP["code"]


def _normalize_setup_code(value: Any) -> str:
    """Upper-case ASCII letters and digits only, so case and separators don't matter."""
    return "".join(ch for ch in str(value or "").upper() if ch.isascii() and ch.isalnum())


def _setup_request_is_local() -> bool:
    """True only for a direct request made on the server computer itself.

    A proxy or tunnel on the same host also connects from 127.0.0.1, so any
    forwarding header disqualifies the request, and the Host must be a loopback
    name (which also stops DNS rebinding).
    """
    if (request.remote_addr or "") not in _LOOPBACK_ADDRS:
        return False
    if any(request.headers.get(name) for name in _FORWARDING_HEADERS):
        return False
    host = urlsplit("//" + (request.host or "")).hostname or ""
    return host in _LOOPBACK_HOSTS


_SESSION_MAX_AGE = 12 * 3600  # seconds from login, however active the session is


def _authenticated() -> bool:
    started = session.get("login_at")
    if not isinstance(started, (int, float)) or time.time() - started > _SESSION_MAX_AGE:
        return False
    return bool(session.get("authenticated")) and session.get("generation") == _credential_generation()


def _is_admin_session() -> bool:
    return _authenticated() and session.get("role") == "admin"


def _reserve_login_attempt(ip: str) -> bool:
    """Count an attempt before the password is checked; False when the limit is reached."""
    now = time.monotonic()
    with _LOGIN_LOCK:
        for key in [k for k, q in _LOGIN_ATTEMPTS.items() if not q or now - q[-1] > _LOGIN_WINDOW]:
            del _LOGIN_ATTEMPTS[key]
        attempts = _LOGIN_ATTEMPTS[ip]
        while attempts and now - attempts[0] > _LOGIN_WINDOW:
            attempts.popleft()
        if len(attempts) >= _LOGIN_LIMIT:
            return False
        attempts.append(now)
        return True


def _require_admin():
    if not _is_admin_session():
        return jsonify({"error": "Akses administrator diperlukan."}), 403
    return None


@app.before_request
def _protect_private_routes():
    public = {"index", "fresh_start", "static", "api_auth_session", "api_auth_login", "api_auth_setup"}
    if request.endpoint in public or request.endpoint is None:
        return None
    if not _authenticated():
        if request.path.startswith("/api/"):
            return jsonify({"error": "Autentikasi diperlukan."}), 401
        return render_template("login.html", owner_configured=_owner_configured()), 401
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        supplied = request.headers.get("X-CSRF-Token", "")
        expected = session.get("csrf", "")
        if not supplied or not expected or not secrets.compare_digest(supplied, expected):
            return jsonify({"error": "Token CSRF tidak valid."}), 403
    return None


# The one external script, pinned with an integrity hash in index.html.
_CHART_SCRIPT = "https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"


@app.context_processor
def _template_globals() -> dict:
    """Name, credit and version for every page, plus whether setup may run here."""
    return {
        "app_name": _app_name(),
        "app_credit": APP_CREDIT,
        "app_version": APP_VERSION,
        "setup_local": _setup_request_is_local(),
    }


@app.after_request
def _security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        f"default-src 'self'; script-src 'self' {_CHART_SCRIPT}; "
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; "
        "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; "
        "form-action 'self'; frame-ancestors 'none'"
    )
    if request.path.startswith("/static/"):
        # Files linked with a content-hash ?v= never change, nor do the bundled fonts;
        # anything else revalidates.
        stable = request.args.get("v") or request.path.startswith("/static/fonts/")
        if stable and response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=604800, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
    elif request.path == "/" or request.path.startswith("/api/") or _authenticated():
        response.headers["Cache-Control"] = "no-store, private"
        response.headers["Pragma"] = "no-cache"
    return response


@app.route("/api/auth/session")
def api_auth_session():
    return jsonify({
        "authenticated": _authenticated(),
        "role": session.get("role") if _authenticated() else None,
        "csrf_token": session.get("csrf") if _authenticated() else None,
        "owner_configured": _owner_configured(),
        "admin_configured": is_admin_password_set(),
    })


@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    ip = request.remote_addr or "unknown"
    if not _reserve_login_attempt(ip):
        return jsonify({"error": "Terlalu banyak percobaan. Coba lagi dalam beberapa menit."}), 429
    body = _json_object()
    if body is None:
        return _bad_body()
    password = str(body.get("password", ""))
    requested_role = body.get("role", "owner")
    role = None
    if requested_role == "admin" and verify_admin_password(password):
        role = "admin"
    elif requested_role != "admin" and _verify_owner(password):
        role = "owner"
    if role is None:
        return jsonify({"error": "Kredensial tidak valid."}), 401
    with _LOGIN_LOCK:
        _LOGIN_ATTEMPTS.pop(ip, None)
    return jsonify({"ok": True, "role": role, "csrf_token": _start_session(role)})


@app.route("/api/auth/setup", methods=["POST"])
def api_auth_setup():
    """First run: set the owner password and app name, then sign the owner in."""
    if _owner_configured():
        return jsonify({"error": "Password pemilik sudah dikonfigurasi."}), 409
    if not _setup_request_is_local():
        return jsonify({"error": "Pengaturan awal hanya dapat dilakukan dari komputer server."}), 403
    ip = request.remote_addr or "unknown"
    if not _reserve_login_attempt(ip):
        return jsonify({"error": "Terlalu banyak percobaan. Coba lagi dalam beberapa menit."}), 429
    body = _json_object()
    if body is None:
        return _bad_body()
    supplied = _normalize_setup_code(body.get("code"))
    if not supplied or not secrets.compare_digest(supplied, _normalize_setup_code(_setup_code())):
        return jsonify({"error": "Kode pengaturan salah. Lihat kodenya di jendela server."}), 403
    try:
        _set_owner_password(str(body.get("password", "")))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    _set_app_name(body.get("app_name"))
    _SETUP["code"] = None
    with _LOGIN_LOCK:
        _LOGIN_ATTEMPTS.pop(ip, None)
    return jsonify({"ok": True, "csrf_token": _start_session("owner")})


@app.route("/api/app", methods=["POST"])
def api_app_settings():
    """Rename the app; needs a signed-in session and the CSRF token."""
    body = _json_object()
    if body is None:
        return _bad_body()
    return jsonify({"ok": True, "name": _set_app_name(body.get("name"))})


@app.route("/api/auth/logout", methods=["POST"])
def api_auth_logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/auth/owner/change", methods=["POST"])
def api_auth_owner_change():
    body = _json_object()
    if body is None:
        return _bad_body()
    current = str(body.get("current_password", ""))
    if not _is_admin_session():
        ip = request.remote_addr or "unknown"
        if not _reserve_login_attempt(ip):
            return jsonify({"error": "Terlalu banyak percobaan. Coba lagi dalam beberapa menit."}), 429
        if not _verify_owner(current):
            return jsonify({"error": "Password saat ini salah."}), 403
        with _LOGIN_LOCK:
            _LOGIN_ATTEMPTS.pop(ip, None)
    try:
        _set_owner_password(str(body.get("new_password", "")))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    session["generation"] = _credential_generation()
    return jsonify({"ok": True})


@app.route("/api/auth/owner/reset", methods=["POST"])
def api_auth_owner_reset():
    denied = _require_admin()
    if denied:
        return denied
    body = _json_object()
    if body is None:
        return _bad_body()
    try:
        _set_owner_password(str(body.get("new_password", "")))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    session["generation"] = _credential_generation()
    return jsonify({"ok": True})

# Cache sederhana
_CACHE: "OrderedDict[str, tuple[float, Any]]" = OrderedDict()
_TTL = 300  # seconds; the data is delayed anyway, so this mainly limits requests to yfinance
_CACHE_MAX = 500
_CACHE_LOCK = threading.Lock()
_IN_FLIGHT: dict[str, "_Flight"] = {}


class _Flight:
    """One in-progress computation that concurrent callers wait on."""

    def __init__(self) -> None:
        self.done = threading.Event()
        self.finished = False
        self.value: Any = None

# Read timeout for every yfinance.history() call. Without it, one hanging upstream
# could hold a Waitress thread forever.
_YF_TIMEOUT = 15


def _cache_get(key: str) -> Any:
    """Cached value, or None when missing or older than the TTL."""
    with _CACHE_LOCK:
        item = _CACHE.get(key)
        if item is None:
            return None
        if time.time() - item[0] >= _TTL:
            del _CACHE[key]
            return None
        _CACHE.move_to_end(key)
        return item[1]


def _cache_set(key: str, value: Any) -> None:
    """Store a value; drops expired entries, then the least recently used, beyond the cap."""
    now = time.time()
    with _CACHE_LOCK:
        for stale in [k for k, (stamp, _) in _CACHE.items() if now - stamp >= _TTL]:
            del _CACHE[stale]
        _CACHE[key] = (now, value)
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)


def _compute_once(key: str, producer) -> Any:
    """Return the cached value for ``key``, or run ``producer`` once for all concurrent callers.

    ``producer`` returns ``(value, cacheable)``. Callers that arrive while it runs
    receive the same value, including uncacheable error results.
    """
    cached = _cache_get(key)
    if cached is not None:
        return cached
    with _CACHE_LOCK:
        flight = _IN_FLIGHT.get(key)
        leader = flight is None
        if leader:
            flight = _IN_FLIGHT[key] = _Flight()
    if not leader:
        flight.done.wait(timeout=120)
        if flight.finished:
            return flight.value
        return producer()[0]
    try:
        value, cacheable = producer()
        if cacheable:
            _cache_set(key, value)
        flight.value, flight.finished = value, True
        return value
    finally:
        flight.done.set()
        with _CACHE_LOCK:
            if _IN_FLIGHT.get(key) is flight:
                del _IN_FLIGHT[key]


def _cache_clear(pattern: Optional[str] = None) -> int:
    """Clear cache entries matching pattern. Returns count cleared."""
    with _CACHE_LOCK:
        if pattern is None:
            count = len(_CACHE)
            _CACHE.clear()
        else:
            count = 0
            keys_to_remove = [k for k in _CACHE if pattern in k]
            for k in keys_to_remove:
                del _CACHE[k]
                count += 1
    return count


# Cache management API
@app.route("/api/cache/clear", methods=["POST"])
def api_cache_clear():
    """Clear all cached data. Admin only."""
    denied = _require_admin()
    if denied:
        return denied
    body = _json_object()
    if body is None:
        return _bad_body()
    pattern = body.get("pattern")
    count = _cache_clear(pattern)
    logger.info(f"Cache cleared: {count} entries" + (f" matching '{pattern}'" if pattern else ""))
    return jsonify({"ok": True, "cleared": count})


@app.route("/api/cache/stats", methods=["GET"])
def api_cache_stats():
    """Get cache statistics."""
    denied = _require_admin()
    if denied:
        return denied
    with _CACHE_LOCK:
        entries = len(_CACHE)
        oldest = min((t for t, _ in _CACHE.values()), default=None)
        newest = max((t for t, _ in _CACHE.values()), default=None)
    return jsonify({
        "entries": entries,
        "ttl_seconds": _TTL,
        "oldest_entry": oldest,
        "newest_entry": newest,
    })


# Util ticker
def normalize(ticker: str) -> str:
    t = (ticker or "").strip().upper()
    if not t or len(t) > 15 or not re.fullmatch(r"[A-Z0-9^=-]+(?:\.[A-Z]{1,4})?", t):
        return ""
    # 4-letter IDX code → add .JK when it has no suffix yet
    if "." not in t and len(t) <= 5 and t.isalpha():
        t += ".JK"
    return t


def _num(x: Any) -> Optional[float]:
    """Safely convert to float, returning None for invalid values."""
    try:
        if x is None:
            return None
        f = float(x)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError, ArithmeticError):
        return None


def _pct(x: Any) -> Optional[float]:
    """Convert a yfinance fraction to a percent.

    Fields such as returnOnEquity, returnOnAssets, profitMargins and payoutRatio
    come from yfinance as decimal fractions (0.23 means 23%), so they are
    multiplied by 100. Not for dividendYield: use _dividend_yield for that.
    """
    v = _num(x)
    if v is None:
        return None
    return v * 100


def _dividend_yield(info: dict, price: Optional[float]) -> Optional[float]:
    """Dividend yield in percent.

    Dividend per share over price is preferred. yfinance's ``dividendYield`` is
    already a percent; ``trailingAnnualDividendYield`` is a fraction.
    """
    dps = _num(info.get("dividendRate")) or _num(info.get("trailingAnnualDividendRate"))
    if dps and price and price > 0:
        return dps / price * 100
    reported = _num(info.get("dividendYield"))
    if reported is not None:
        return reported
    trailing = _num(info.get("trailingAnnualDividendYield"))
    return trailing * 100 if trailing is not None else None


# Endpoint
@app.route("/")
def index():
    if not _authenticated():
        return render_template("login.html", owner_configured=_owner_configured())
    return render_template("index.html")


@app.route("/fresh-start")
def fresh_start():
    """One-time browser cache/service-worker cleanup before opening the app."""
    response = app.make_response(render_template("fresh-start.html"))
    response.headers["Clear-Site-Data"] = '"cache"'
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return response


# Admin password API
@app.route("/api/admin/status", methods=["GET"])
def api_admin_status():
    return jsonify({
        "configured": is_admin_password_set(),
        "source": admin_password_source(),
        "is_admin": _is_admin_session(),
    })


@app.route("/api/admin/change", methods=["POST"])
def api_admin_change():
    denied = _require_admin()
    if denied:
        return denied
    body = _json_object()
    if body is None:
        return _bad_body()
    current = str(body.get("current_password", ""))
    new_pass = str(body.get("new_password", ""))
    result = change_admin_password(current, new_pass)
    return jsonify(result), 200 if result["success"] else 400


# State sync (data on the server)
# The app data (watchlist, portfolio, finances, purchases, ...) lives in one file on
# the server, so every device sees the same data while the server runs.
_STATE_DIR = _DATA_DIR
_STATE_FILE = os.path.join(_STATE_DIR, "state.json")
_STATE_META_FILE = os.path.join(_STATE_DIR, "state-meta.json")
_state_lock = threading.Lock()

_PHOTOCARD_DIR = os.path.join(_STATE_DIR, "photocards")
_PHOTOCARD_SIDES = frozenset({"left", "right"})
_PHOTOCARD_EXTENSIONS = ("jpg", "png", "webp", "gif")
_PHOTOCARD_MAX_BYTES = 7 * 1024 * 1024
_photocard_lock = threading.Lock()
os.makedirs(_PHOTOCARD_DIR, exist_ok=True)

_ALLOWED_STATE_KEYS = {
    "mc_theme", "mc_font", "saham_autorefresh_v1", "mc_mode", "saham_profile",
    "mc_setup_done", "saham_watchlist_v1", "saham_portfolio_v1", "mc_rdn_cash",
    "mc_fin_hist", "mc_fin_ath", "mc_fin_settings", "mc_fin_accounts",
    "mc_fin_recurring", "mc_fin_tx", "mc_fin_debts", "mc_fin_targets",
    "mc_barang_projects", "mc_barang_cur", "mc_barang_items", "mc_ara", "mc_style",
    "mc_birate", "mc_ipo_saves", "saham_bench_global", "saham_bench_stock",
    "saham_ma_v1", "mc_journal", "mc_hide", "mc_hide_pages", "mc_density",
    "mc_tab_order", "mc_home_order", "mc_dividends", "mc_compare", "mc_collapsed",
    "mc_tab_hidden", "mc_home_hidden", "mc_jr_autosync",
    "mc_mutual_funds_v1", "mc_bonds_v1", "mc_investment_view_v1",
    "mc_font_size", "mc_photocards",
}


class StateUnavailable(Exception):
    """The state file exists but cannot be read; never treat it as empty."""


def _legacy_revision() -> int:
    value = _load_json(_STATE_META_FILE).get("revision", 0)
    return value if isinstance(value, int) and value >= 0 else 0


_corrupt_seen: set[tuple[float, int]] = set()


def _preserve_corrupt_state(exc: Exception) -> None:
    """Copy an unreadable state file aside once per distinct file version."""
    try:
        info = os.stat(_STATE_FILE)
    except OSError:
        return
    marker = (info.st_mtime, info.st_size)
    if marker in _corrupt_seen:
        return
    _corrupt_seen.add(marker)
    corrupt = f"{_STATE_FILE}.corrupt-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}"
    try:
        shutil.copy2(_STATE_FILE, corrupt)
        logger.error("state.json is unreadable (%s); a copy was kept at %s", exc, corrupt)
    except OSError:
        logger.exception("state.json is unreadable and could not be copied")


def _read_state_doc() -> dict:
    """Return ``{"revision", "epoch", "state"}`` from the single state file.

    Raises:
        StateUnavailable: when the file exists but is unreadable or malformed.
    """
    try:
        with open(_STATE_FILE, "r", encoding="utf-8-sig") as f:
            value = json.load(f)
    except FileNotFoundError:
        return {"revision": _legacy_revision(), "epoch": 0, "state": {}}
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        _preserve_corrupt_state(exc)
        raise StateUnavailable(str(exc)) from exc
    if not isinstance(value, dict):
        raise StateUnavailable("state.json is not a JSON object")
    if value.get("format") == 2:
        state = value.get("state")
        revision = value.get("revision", 0)
        epoch = value.get("epoch", 0)
        if not isinstance(state, dict) or not isinstance(revision, int) or not isinstance(epoch, int):
            raise StateUnavailable("state.json has an invalid structure")
        return {"revision": revision, "epoch": epoch, "state": state}
    return {"revision": _legacy_revision(), "epoch": 0, "state": value}


def _write_state_doc(doc: dict) -> None:
    """Atomically write state, revision and epoch together; keep the previous file as .bak."""
    os.makedirs(os.path.dirname(_STATE_FILE), exist_ok=True)
    payload = {"format": 2, "revision": doc["revision"], "epoch": doc["epoch"], "state": doc["state"]}
    tmp = _STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    if os.path.exists(_STATE_FILE):
        shutil.copy2(_STATE_FILE, _STATE_FILE + ".bak")
    _replace_file(tmp, _STATE_FILE)
    if os.path.exists(_STATE_META_FILE):
        try:
            os.remove(_STATE_META_FILE)
        except OSError:
            logger.warning("Could not remove the old state-meta.json")


def _migrate_owner_password() -> None:
    """Move a plaintext owner password out of synchronized state into a server-side hash."""
    with _state_lock:
        try:
            doc = _read_state_doc()
        except StateUnavailable:
            doc = None
        legacy = None
        if doc is not None:
            legacy = doc["state"].pop("mc_password", None)
            custom_theme = doc["state"].pop("mc_custom_theme", None)
            if legacy is not None or custom_theme is not None:
                _write_state_doc(doc)
        if not _owner_configured():
            env_password = os.environ.get("OWNER_PASSWORD", "")
            if env_password and len(env_password) < 8:
                logger.warning("OWNER_PASSWORD ignored: it must be at least 8 characters")
                env_password = ""
            candidate = str(legacy or env_password)
            if candidate:
                _atomic_json(_OWNER_FILE, {
                    "password": generate_password_hash(candidate, method="scrypt"),
                    "migrated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                })
                logger.info("Owner password from OWNER_PASSWORD stored as a server-side hash")


def _acquire_instance_lock(path: str):
    """Hold an exclusive lock on ``path``; None when another instance already holds it.

    Two server processes sharing one data folder would each pass the revision
    check and silently lose one device's edits.
    """
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    handle = open(path, "a+b")
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        return None
    return handle


def _release_instance_lock(handle) -> None:
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass
    finally:
        handle.close()


def _seed_app_name() -> None:
    """Name a fresh install from APP_NAME, or keep an older install's own brand."""
    if os.path.exists(_APP_FILE):
        return
    env_name = os.environ.get("APP_NAME", "").strip()
    if env_name:
        _set_app_name(env_name)
        return
    try:
        profile = _read_state_doc()["state"].get("saham_profile")
    except StateUnavailable:
        return
    try:
        brand = json.loads(profile).get("brand") if isinstance(profile, str) else None
    except (ValueError, AttributeError):
        brand = None
    if isinstance(brand, str) and brand.strip():
        _set_app_name(brand)


_migrate_owner_password()
_seed_app_name()
if not _owner_configured():
    _setup_code()  # logged now, so the code is in the console before anyone opens the page

_STATE_UNAVAILABLE = ({"error": "Data server tidak dapat dibaca. Hubungi pemilik server."}, 503)


@app.route("/api/state", methods=["GET"])
def api_state_get():
    with _state_lock:
        try:
            doc = _read_state_doc()
        except StateUnavailable:
            return jsonify(_STATE_UNAVAILABLE[0]), _STATE_UNAVAILABLE[1]
        return jsonify(doc)


@app.route("/api/state/revision", methods=["GET"])
def api_state_revision():
    with _state_lock:
        try:
            doc = _read_state_doc()
        except StateUnavailable:
            return jsonify(_STATE_UNAVAILABLE[0]), _STATE_UNAVAILABLE[1]
        return jsonify({"revision": doc["revision"], "epoch": doc["epoch"]})


@app.route("/api/state", methods=["POST"])
def api_state_set():
    body = _json_object()
    if body is None:
        return _bad_body()
    changes = body.get("changes") or {}
    removals = body.get("removals") or []
    client_revision = body.get("revision")
    client_epoch = body.get("epoch")
    if not isinstance(changes, dict) or not isinstance(removals, list):
        return jsonify({"error": "Format perubahan state tidak valid."}), 400
    requested = set(changes) | {str(key) for key in removals}
    invalid = sorted(requested - _ALLOWED_STATE_KEYS)
    if invalid:
        return jsonify({"error": "Kunci state tidak diizinkan.", "keys": invalid}), 400
    if any(not isinstance(value, str) or len(value) > 500_000 for value in changes.values()):
        return jsonify({"error": "Nilai state harus berupa teks dan tidak melebihi batas."}), 400
    with _state_lock:
        try:
            doc = _read_state_doc()
        except StateUnavailable:
            return jsonify(_STATE_UNAVAILABLE[0]), _STATE_UNAVAILABLE[1]
        conflict = {"revision": doc["revision"], "epoch": doc["epoch"]}
        if client_epoch is not None and client_epoch != doc["epoch"]:
            return jsonify({"error": "Data server telah dikosongkan.", "reason": "epoch", **conflict}), 409
        if client_revision is not None and client_revision != doc["revision"]:
            return jsonify({"error": "State telah berubah di perangkat lain.", "reason": "revision", **conflict}), 409
        doc["state"].update(changes)
        for k in removals:
            doc["state"].pop(k, None)
        doc["revision"] += 1
        _write_state_doc(doc)
        return jsonify({"ok": True, "keys": len(doc["state"]), "revision": doc["revision"], "epoch": doc["epoch"]})


@app.route("/api/state/clear", methods=["POST"])
def api_state_clear():
    with _state_lock:
        try:
            revision = _read_state_doc()["revision"] + 1
        except StateUnavailable:
            # Writing now would copy the unreadable file over the last good .bak.
            return jsonify(_STATE_UNAVAILABLE[0]), _STATE_UNAVAILABLE[1]
        # Milliseconds stay exact as a JavaScript number.
        doc = {"revision": revision, "epoch": int(time.time() * 1000), "state": {}}
        _write_state_doc(doc)
    return jsonify({"ok": True, "revision": doc["revision"], "epoch": doc["epoch"]})


def _photocard_side(side: str) -> str | None:
    """Return an allowlisted photo-card side."""
    value = str(side).lower()
    return value if value in _PHOTOCARD_SIDES else None


def _photocard_format(data: bytes) -> tuple[str, str] | None:
    """Identify supported raster formats from their file signature."""
    if data.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "gif", "image/gif"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "webp", "image/webp"
    return None


def _photocard_existing(side: str) -> tuple[str, str] | None:
    """Find the one fixed local file belonging to an allowlisted side."""
    safe_side = _photocard_side(side)
    if not safe_side:
        return None
    for extension in _PHOTOCARD_EXTENSIONS:
        path = os.path.join(_PHOTOCARD_DIR, f"{safe_side}.{extension}")
        if os.path.isfile(path):
            return path, extension
    return None


def _photocard_metadata() -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    with _photocard_lock:
        for side in sorted(_PHOTOCARD_SIDES):
            existing = _photocard_existing(side)
            if existing:
                stat = os.stat(existing[0])
                result[side] = {"available": True, "revision": str(stat.st_mtime_ns)}
            else:
                result[side] = {"available": False, "revision": "0"}
    return result


@app.route("/api/photocards")
def api_photocards_metadata():
    return jsonify(_photocard_metadata())


@app.route("/api/photocards/<side>", methods=["GET", "POST", "DELETE"])
def api_photocard(side: str):
    safe_side = _photocard_side(side)
    if not safe_side:
        return jsonify({"error": "Sisi photo card tidak valid."}), 400

    if request.method == "GET":
        with _photocard_lock:
            existing = _photocard_existing(safe_side)
            data = None
            if existing:
                with open(existing[0], "rb") as handle:
                    data = handle.read()
        if not existing:
            return jsonify({"error": "Photo card belum tersedia."}), 404
        response = send_file(
            io.BytesIO(data),
            mimetype=f"image/{'jpeg' if existing[1] == 'jpg' else existing[1]}",
            conditional=False,
            max_age=0,
        )
        response.headers["Cache-Control"] = "no-store, private"
        return response

    if request.method == "DELETE":
        removed = False
        with _photocard_lock:
            for extension in _PHOTOCARD_EXTENSIONS:
                path = os.path.join(_PHOTOCARD_DIR, f"{safe_side}.{extension}")
                try:
                    os.remove(path)
                    removed = True
                except FileNotFoundError:
                    pass
        return jsonify({"ok": True, "removed": removed})

    upload = request.files.get("image")
    if upload is None:
        return jsonify({"error": "Pilih file gambar terlebih dahulu."}), 400
    data = upload.stream.read(_PHOTOCARD_MAX_BYTES + 1)
    if not data:
        return jsonify({"error": "File gambar kosong."}), 400
    if len(data) > _PHOTOCARD_MAX_BYTES:
        return jsonify({"error": "Ukuran gambar maksimal 7 MB."}), 413
    image_format = _photocard_format(data)
    if image_format is None:
        return jsonify({"error": "Format harus JPEG, PNG, WebP, atau GIF."}), 400

    extension, _mimetype = image_format
    target = os.path.join(_PHOTOCARD_DIR, f"{safe_side}.{extension}")
    temporary = os.path.join(_PHOTOCARD_DIR, f".{safe_side}-{secrets.token_hex(8)}.tmp")
    try:
        with open(temporary, "xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        with _photocard_lock:
            os.replace(temporary, target)
            for old_extension in _PHOTOCARD_EXTENSIONS:
                old_path = os.path.join(_PHOTOCARD_DIR, f"{safe_side}.{old_extension}")
                if old_path == target:
                    continue
                try:
                    os.remove(old_path)
                except FileNotFoundError:
                    pass
    except OSError:
        logger.exception("Could not save the %s photo card", safe_side)
        try:
            os.remove(temporary)
        except FileNotFoundError:
            pass
        return jsonify({"error": "Gambar gagal disimpan di penyimpanan lokal."}), 500

    stat = os.stat(target)
    return jsonify({"ok": True, "available": True, "revision": str(stat.st_mtime_ns)})


_DAILY_INTERVALS = {"1d", "1wk", "1mo"}
# yfinance only serves intraday bars for short lookbacks: 5m/15m up to 60 days,
# 60m up to 730 days. The chart picker in index.html offers exactly these pairs.
_WIB = dt.timezone(dt.timedelta(hours=7), "WIB")
_IDX_SESSION_END = dt.time(16, 15)


def _now_wib() -> dt.datetime:
    return dt.datetime.now(_WIB)


def _completed_sessions(daily: pd.DataFrame) -> pd.DataFrame:
    """Drop today's daily bar while the IDX session is still trading."""
    if len(daily) < 2:
        return daily
    last = daily.index[-1]
    last_date = last.tz_convert(_WIB).date() if last.tzinfo else last.date()
    now = _now_wib()
    if last_date == now.date() and now.time() < _IDX_SESSION_END:
        return daily.iloc[:-1]
    return daily


def _daily_history(yt: Any, tk: str) -> Optional[pd.DataFrame]:
    """One year of daily bars for day statistics, pivots and levels (cached)."""
    key = f"daily:{tk}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    try:
        daily = yt.history(period="1y", interval="1d", auto_adjust=False, timeout=_YF_TIMEOUT)
    except Exception:  # noqa: BLE001
        logger.warning("Daily history unavailable for %s", tk)
        return None
    if daily is None or daily.empty:
        return None
    daily = daily.dropna(subset=["Close"])
    _cache_set(key, daily)
    return daily


_STOCK_TIMEFRAMES = {
    "1d": {"5m", "15m", "60m"},
    "5d": {"5m", "15m", "60m"},
    "1mo": {"15m", "60m", "1d", "1wk"},
    "3mo": {"60m", "1d", "1wk"},
    "6mo": {"1d", "1wk"},
    "1y": {"1d", "1wk", "1mo"},
    "2y": {"1d", "1wk", "1mo"},
    "5y": {"1d", "1wk", "1mo"},
    "ytd": {"1d", "1wk"},
    "max": {"1d", "1wk", "1mo"},
}


@app.route("/api/stock/<ticker>")
def api_stock(ticker):
    rng = request.args.get("range", "1y")
    interval = request.args.get("interval", "1d")
    if rng not in _STOCK_TIMEFRAMES:
        return jsonify({"error": "Rentang data tidak valid."}), 400
    if interval not in _STOCK_TIMEFRAMES[rng]:
        return jsonify({"error": "Interval tidak tersedia untuk rentang ini."}), 400
    tk = normalize(ticker)
    if not tk:
        return jsonify({"error": "Kode saham tidak valid."}), 400
    key = f"{tk}:{rng}:{interval}"

    def build():
        try:
            yt = yf.Ticker(tk)
            hist = yt.history(period=rng, interval=interval, auto_adjust=False, timeout=_YF_TIMEOUT)
        except Exception:  # noqa: BLE001
            logger.exception("Upstream stock request failed for %s", tk)
            return {"error": "Data pasar sementara tidak tersedia."}, 502

        if hist is None or hist.empty:
            return {"error": f"Data kosong untuk {tk}. Cek kode saham."}, 404

        hist = hist.dropna(subset=["Close"])
        if len(hist) < 5:
            return {"error": f"Data terlalu sedikit untuk {tk}."}, 404

        # Fundamentals (may be empty for some issuers)
        info = {}
        try:
            info = yt.info or {}
        except Exception:  # noqa: BLE001
            info = {}

        close = hist["Close"]
        last = float(close.iloc[-1])
        # Day statistics always come from daily bars, whatever the chart interval.
        daily = hist if interval == "1d" and len(hist) >= 120 else _daily_history(yt, tk)
        if daily is None or len(daily) < 2:
            # Intraday or weekly bars cannot stand in for the day's figures.
            daily = hist if interval == "1d" else None
        if daily is not None:
            day_close = daily["Close"]
            prev = float(day_close.iloc[-2]) if len(day_close) > 1 else last
            change = float(day_close.iloc[-1]) - prev
            change_pct = (change / prev * 100) if prev else 0
            day = {
                "change": round(change, 2),
                "changePct": round(change_pct, 2),
                "dayHigh": _num(daily["High"].iloc[-1]),
                "dayLow": _num(daily["Low"].iloc[-1]),
                "volume": _num(daily["Volume"].iloc[-1]),
            }
            pivots = ind.pivot_points(_completed_sessions(daily))
            levels = ind.support_resistance(daily)
        else:
            day = dict.fromkeys(("change", "changePct", "dayHigh", "dayLow", "volume"))
            pivots = ind.pivot_points(hist.iloc[0:0])
            levels = {}

        eps = _num(info.get("trailingEps"))
        pbv = _num(info.get("priceToBook"))
        bvps = (last / pbv) if (pbv and pbv != 0) else _num(info.get("bookValue"))
        dps = _num(info.get("dividendRate")) or _num(info.get("trailingAnnualDividendRate"))

        fundamentals = {
            "longName": info.get("longName") or info.get("shortName") or tk,
            "currency": info.get("currency") or "IDR",
            "marketCap": _num(info.get("marketCap")),
            "per": _num(info.get("trailingPE")),
            "forwardPer": _num(info.get("forwardPE")),
            "pbv": pbv,
            "eps": eps,
            "bvps": bvps,
            "roe": _pct(info.get("returnOnEquity")),
            "roa": _pct(info.get("returnOnAssets")),
            "npm": _pct(info.get("profitMargins")),
            "dividendYield": _dividend_yield(info, last),
            "dps": dps,
            "payoutRatio": _pct(info.get("payoutRatio")),
            "beta": _num(info.get("beta")),
            "high52": _num(info.get("fiftyTwoWeekHigh")),
            "low52": _num(info.get("fiftyTwoWeekLow")),
            "avgVolume": _num(info.get("averageVolume")),
            "sector": info.get("sector"),
            "targetMean": _num(info.get("targetMeanPrice")),
            "targetHigh": _num(info.get("targetHighPrice")),
            "targetLow": _num(info.get("targetLowPrice")),
            "recommendation": info.get("recommendationKey"),
        }

        payload = {
            "ticker": tk,
            # Daily, weekly and monthly bars carry no time of day, and a weekly or
            # monthly bar is dated at its start, so they are as of the last session.
            "asOf": (hist.index[-1].strftime("%Y-%m-%d %H:%M %Z").strip()
                     if interval not in _DAILY_INTERVALS
                     else (daily if daily is not None else hist).index[-1].strftime("%Y-%m-%d")),
            "fetchedAt": _now_wib().strftime("%Y-%m-%d %H:%M WIB"),
            "delayedNote": "Data tertunda ±15 menit, bukan real-time bursa.",
            "price": last,
            **day,
            "dayStats": daily is not None,
            "fundamentals": fundamentals,
            "latest": ind.latest_values(hist),
            "signals": ind.compute_signals(hist),
            "pivots": pivots,
            "levels": levels,
            "chart": ind.series_for_chart(hist, intraday=interval not in _DAILY_INTERVALS),
            "interval": interval,
        }
        return payload, 200

    def produce():
        result = build()
        # Without daily bars the day figures are missing; try again next time.
        return result, result[1] == 200 and result[0].get("dayStats", True)

    payload, status = _compute_once(key, produce)
    return jsonify(payload), status


@app.route("/api/search")
def api_search():
    return jsonify({"results": search_tickers(request.args.get("q", "") or "", limit=12)})


@app.route("/api/quote/<ticker>")
def api_quote(ticker):
    """Short quote for the watchlist (fast)."""
    tk = normalize(ticker)
    if not tk:
        return jsonify({"ticker": ticker, "error": "Kode saham tidak valid."}), 400
    key = f"q:{tk}"
    cached = _cache_get(key)
    if cached is not None:
        return jsonify(cached)
    try:
        hist = yf.Ticker(tk).history(period="5d", interval="1d", auto_adjust=False, timeout=_YF_TIMEOUT)
        if hist is not None:
            hist = hist.dropna(subset=["Close"])
        if hist is None or hist.empty:
            return jsonify({"ticker": tk, "error": "no data"}), 404
        last = float(hist["Close"].iloc[-1])
        prev = float(hist["Close"].iloc[-2]) if len(hist) > 1 else last
        out = {"ticker": tk, "price": last,
               "change": round(last - prev, 2),
               "changePct": round((last - prev) / prev * 100 if prev else 0, 2)}
        _cache_set(key, out)
        return jsonify(out)
    except Exception:  # noqa: BLE001
        logger.warning("Quote unavailable for %s", tk)
        return jsonify({"ticker": tk, "error": "Data pasar sementara tidak tersedia."}), 502


@app.route("/api/financials/<ticker>")
def api_financials(ticker):
    tk = normalize(ticker)
    if not tk:
        return jsonify({"quarters": [], "note": "Kode saham tidak valid."}), 400
    key = f"fin:{tk}"
    cached = _cache_get(key)
    if cached is not None:
        return jsonify(cached)
    try:
        yt = yf.Ticker(tk)
        df = None
        for attr in ("quarterly_income_stmt", "quarterly_financials"):
            try:
                d = getattr(yt, attr)
                if d is not None and not d.empty:
                    df = d
                    break
            except Exception:  # noqa: BLE001
                pass
        if df is None or df.empty:
            return jsonify({"quarters": [], "note": "Data kuartalan tidak tersedia."})

        def find_row(names):
            for n in names:
                if n in df.index:
                    return df.loc[n]
            return None

        rev = find_row(["Total Revenue", "TotalRevenue", "Operating Revenue"])
        ni = find_row(["Net Income", "NetIncome", "Net Income Common Stockholders",
                       "Net Income From Continuing Operation Net Minority Interest"])
        cols = list(df.columns)[:8]
        quarters = []
        for c in cols:
            if hasattr(c, "month"):
                lab = f"Q{(c.month - 1) // 3 + 1}'{c.year % 100:02d}"
            else:
                lab = str(c)[:7]
            quarters.append({
                "label": lab,
                "revenue": _num(rev[c]) if (rev is not None and c in rev.index) else None,
                "netIncome": _num(ni[c]) if (ni is not None and c in ni.index) else None,
            })
        quarters.reverse()  # oldest → newest
        res = {"quarters": quarters}
        _cache_set(key, res)
        return jsonify(res)
    except Exception:  # noqa: BLE001
        logger.warning("Quarterly financials unavailable for %s", tk)
        return jsonify({"quarters": [], "note": "Data kuartalan gagal diambil. Coba lagi nanti."})


# Portofolio
def _holding_metrics(tk: str) -> dict:
    """Price and key metrics for one held stock (cached for 5 minutes)."""
    cached = _cache_get(f"hold:{tk}")
    if cached is not None:
        return cached
    try:
        yt = yf.Ticker(tk)
        hist = yt.history(period="6mo", interval="1d", auto_adjust=False, timeout=_YF_TIMEOUT)
        if hist is None or hist.empty:
            return {"ticker": tk, "error": "data kosong"}
        hist = hist.dropna(subset=["Close"])
        if len(hist) < 5:
            return {"ticker": tk, "error": "data terlalu sedikit"}
        info = {}
        try:
            info = yt.info or {}
        except Exception:  # noqa: BLE001
            info = {}
        close = hist["Close"]
        price = float(close.iloc[-1])
        prev = float(close.iloc[-2]) if len(close) > 1 else price
        sig = ind.compute_signals(hist)
        out = {
            "ticker": tk,
            "name": info.get("longName") or info.get("shortName") or tk,
            "price": price,
            "prevClose": prev,
            "changePct": round((price - prev) / prev * 100 if prev else 0, 2),
            "signal": sig["label"], "score": sig["score"],
            "per": _num(info.get("trailingPE")), "pbv": _num(info.get("priceToBook")),
            "roe": _pct(info.get("returnOnEquity")),
            "dividendYield": _dividend_yield(info, price),
            "dps": _num(info.get("dividendRate")) or _num(info.get("trailingAnnualDividendRate")),
            "targetMean": _num(info.get("targetMeanPrice")),
            "sector": info.get("sector") or info.get("industry") or None,
        }
        ex = _num(info.get("exDividendDate"))
        if ex:
            try:
                out["exDate"] = dt.datetime.fromtimestamp(ex, tz=dt.timezone.utc).date().isoformat()
                out["exFuture"] = ex > time.time()
            except Exception:  # noqa: BLE001
                out["exDate"] = None
                out["exFuture"] = False
        else:
            out["exDate"] = None
            out["exFuture"] = False
        _cache_set(f"hold:{tk}", out)
        return out
    except Exception as e:  # noqa: BLE001
        logger.warning("Holding data unavailable for %s: %s", tk, type(e).__name__)
        return {"ticker": tk, "error": "Data pasar sementara tidak tersedia."}


def _positive(value: Any) -> Optional[float]:
    """Finite number above zero, else None."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) and number > 0 else None


def _holdings_from_body() -> Optional[list[tuple[str, float, Optional[float]]]]:
    """Parse ``holdings`` from the JSON body into (ticker, lots, avg) tuples.

    Returns None when ``holdings`` is not a list. Entries that are not objects or
    have no valid ticker or lots are skipped; an invalid ``avg`` becomes None.
    """
    body = _json_object()
    if body is None:
        return None
    raw = body.get("holdings") or []
    if not isinstance(raw, list):
        return None
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        tk = normalize(str(item.get("ticker", "")))
        lots = _positive(item.get("lots"))
        if tk and lots:
            out.append((tk, lots, _positive(item.get("avg"))))
    return out


_BAD_HOLDINGS = ({"error": "Format holdings tidak valid."}, 400)


def _metrics_for(tickers: list[str]) -> dict[str, dict]:
    """Fetch holding metrics for several tickers in parallel."""
    from concurrent.futures import ThreadPoolExecutor
    unique = list(dict.fromkeys(tickers))
    if not unique:
        return {}
    with ThreadPoolExecutor(max_workers=min(8, len(unique))) as ex:
        return dict(zip(unique, ex.map(_holding_metrics, unique)))


@app.route("/api/portfolio", methods=["POST"])
def api_portfolio():
    parsed = _holdings_from_body()
    if parsed is None:
        return jsonify(_BAD_HOLDINGS[0]), _BAD_HOLDINGS[1]
    parsed = [(tk, lots, avg) for tk, lots, avg in parsed if avg]
    metrics = _metrics_for([tk for tk, _, _ in parsed])
    holdings, total_cost, total_value, total_div, total_day = [], 0.0, 0.0, 0.0, 0.0
    for tk, lots, avg in parsed:
        m = metrics[tk]
        shares = lots * 100
        cost = shares * avg
        row = {"ticker": tk, "name": m.get("name", tk), "lots": lots, "shares": shares,
               "avg": avg, "cost": cost, "error": m.get("error")}
        if m.get("error"):
            row.update({"price": None, "value": None, "pl": None, "plPct": None})
            holdings.append(row)
            continue
        price = m["price"]
        value = shares * price
        pl = value - cost
        prev_close = m.get("prevClose") or price
        day_change = shares * (price - prev_close)   # today's gain or loss (Rp)
        dps = m.get("dps") or 0
        annual_div = shares * dps if dps else 0
        row.update({
            "price": price, "changePct": m["changePct"], "value": value,
            "prevClose": prev_close, "dayChange": day_change,
            "pl": pl, "plPct": (pl / cost * 100) if cost else 0,
            "signal": m["signal"], "score": m["score"],
            "per": m["per"], "pbv": m["pbv"], "roe": m["roe"],
            "dividendYield": m["dividendYield"], "dps": m["dps"],
            "annualDividend": annual_div,
            "yieldOnCost": (dps / avg * 100) if (dps and avg) else None,
            "targetMean": m["targetMean"],
            "targetUpside": ((m["targetMean"] - price) / price * 100) if m.get("targetMean") and price else None,
            "sector": m.get("sector") or "Lainnya",
        })
        total_cost += cost
        total_value += value
        total_div += annual_div
        total_day += day_change
        holdings.append(row)

    for r in holdings:
        r["weight"] = round((r["value"] / total_value * 100), 2) if (r.get("value") and total_value) else 0

    # Alokasi per sektor
    sectors: dict[str, float] = {}
    for r in holdings:
        if r.get("error") or not r.get("value"):
            continue
        sec = r.get("sector") or "Lainnya"
        sectors[sec] = sectors.get(sec, 0.0) + r["value"]
    allocation = [{"name": k, "value": v,
                   "weight": round(v / total_value * 100, 2) if total_value else 0}
                  for k, v in sectors.items()]
    allocation.sort(key=lambda x: -x["value"])

    total_pl = total_value - total_cost
    return jsonify({
        "holdings": holdings,
        "allocation": allocation,
        "totals": {
            "cost": total_cost, "value": total_value, "pl": total_pl,
            "plPct": (total_pl / total_cost * 100) if total_cost else 0,
            "count": len([h for h in holdings if not h.get("error")]),
            "annualDividend": total_div,
            "divYieldOnCost": (total_div / total_cost * 100) if total_cost else 0,
            "dayChange": total_day,
            "dayChangePct": (total_day / (total_value - total_day) * 100) if (total_value - total_day) else 0,
        },
    })


def _period_return(symbol: str, rng: str):
    """Percent price change (first close → last close) over the given period."""
    try:
        h = yf.Ticker(symbol).history(period=rng, interval="1d", auto_adjust=False, timeout=_YF_TIMEOUT)
        if h is None or h.empty:
            return None
        h = h.dropna(subset=["Close"])
        if len(h) < 2:
            return None
        first = float(h["Close"].iloc[0])
        last = float(h["Close"].iloc[-1])
        if first <= 0:
            return None
        return {"ret": (last / first - 1) * 100, "last": last}
    except Exception:  # noqa: BLE001
        return None


@app.route("/api/portfolio/performance", methods=["POST"])
def api_portfolio_performance():
    """Compare the portfolio (current holdings) with IHSG over the chosen period."""
    body = _json_object()
    if body is None:
        return _bad_body()
    parsed = _holdings_from_body()
    if parsed is None:
        return jsonify(_BAD_HOLDINGS[0]), _BAD_HOLDINGS[1]
    rng = body.get("range", "1y")
    if rng not in ("1mo", "3mo", "6mo", "1y", "2y", "ytd", "5y"):
        rng = "1y"
    tickers = [(tk, lots) for tk, lots, _ in parsed]
    key = f"perf:{rng}:" + ",".join(sorted(f"{t}:{l}" for t, l in tickers))
    cached = _cache_get(key)
    if cached is not None:
        return jsonify(cached)

    idx = _period_return("^JKSE", rng)

    def work(item):
        tk, lots = item
        r = _period_return(tk, rng)
        if not r:
            return {"ticker": tk, "ret": None, "value": None}
        end_value = lots * 100 * r["last"]
        start_value = end_value / (1 + r["ret"] / 100) if r["ret"] > -100 else None
        return {"ticker": tk, "ret": r["ret"], "value": end_value, "startValue": start_value}

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(work, tickers))

    total_val = sum(x["value"] for x in results if x.get("value"))
    total_start = sum(x["startValue"] for x in results if x.get("startValue"))
    port_ret = None
    if total_start:
        port_ret = sum(x["ret"] * x["startValue"] for x in results
                       if x.get("ret") is not None and x.get("startValue")) / total_start
    for x in results:
        x["weight"] = round(x["startValue"] / total_start * 100, 2) if (x.get("startValue") and total_start) else 0
        if x.get("ret") is not None:
            x["ret"] = round(x["ret"], 2)
    res = {
        "range": rng,
        "ihsg": round(idx["ret"], 2) if idx else None,
        "portfolio": round(port_ret, 2) if port_ret is not None else None,
        "delta": round(port_ret - idx["ret"], 2) if (port_ret is not None and idx) else None,
        "holdings": sorted(results, key=lambda z: -(z.get("weight") or 0)),
    }
    _cache_set(key, res)
    return jsonify(res)


@app.route("/api/portfolio/valueseries", methods=["POST"])
def api_portfolio_valueseries():
    """Daily portfolio value (Σ shares × close) plus the invested-capital line."""
    body = _json_object()
    if body is None:
        return _bad_body()
    parsed = _holdings_from_body()
    if parsed is None:
        return jsonify(_BAD_HOLDINGS[0]), _BAD_HOLDINGS[1]
    rng = body.get("range", "3mo")
    if rng not in ("1mo", "3mo", "6mo", "1y", "2y", "ytd", "5y"):
        rng = "3mo"
    holds = [(tk, lots * 100, avg or 0.0) for tk, lots, avg in parsed]
    invested = sum(shares * avg for _, shares, avg in holds)
    if not holds:
        return jsonify({"series": [], "invested": 0, "range": rng})
    key = f"pval:{rng}:" + ",".join(sorted(f"{t}:{s}:{a}" for t, s, a in holds))
    cached = _cache_get(key)
    if cached is not None:
        return jsonify(cached)
    series_map, counts, n = {}, {}, 0
    for tk, shares, _avg in holds:
        try:
            hist = yf.Ticker(tk).history(period=rng, interval="1d", auto_adjust=False, timeout=_YF_TIMEOUT)
            if hist is None or hist.empty:
                continue
            hist = hist.dropna(subset=["Close"])
            if hist.empty:
                continue
        except Exception:  # noqa: BLE001
            logger.warning("Value series skipped %s", tk)
            continue
        n += 1
        for ts, c in hist["Close"].items():
            d = ts.date().isoformat()
            series_map[d] = series_map.get(d, 0.0) + shares * float(c)
            counts[d] = counts.get(d, 0) + 1
    # Only dates on which every ticker that returned data has a close.
    dates = sorted(d for d in series_map if counts.get(d, 0) == n)
    series = [{"time": d, "value": round(series_map[d], 2)} for d in dates]
    res = {"series": series, "invested": round(invested, 2), "range": rng}
    _cache_set(key, res)
    return jsonify(res)


@app.route("/api/dividends", methods=["POST"])
def api_dividends():
    parsed = _holdings_from_body()
    if parsed is None:
        return jsonify(_BAD_HOLDINGS[0]), _BAD_HOLDINGS[1]
    metrics = _metrics_for([tk for tk, _, _ in parsed])
    rows, total = [], 0.0
    for tk, lots, avg in parsed:
        m = metrics[tk]
        if m.get("error"):
            continue
        shares = lots * 100
        dps = m.get("dps") or 0
        annual = shares * dps
        total += annual
        rows.append({
            "ticker": tk, "name": m.get("name"), "lots": lots, "dps": dps,
            "annual": annual, "yieldOnCost": (dps / avg * 100) if (dps and avg) else None,
            "exDate": m.get("exDate"), "exFuture": m.get("exFuture"),
        })
    rows.sort(key=lambda x: -x["annual"])
    return jsonify({"rows": rows, "totalAnnual": total, "monthlyAvg": total / 12 if total else 0,
                    "upcoming": [r for r in rows if r.get("exFuture")]})


@app.route("/api/compare")
def api_compare():
    """Metrics for up to four stocks, side by side."""
    raw = (request.args.get("tickers", "") or "").split(",")
    tks, seen = [], set()
    for t in raw:
        tk = normalize(t)
        if tk and tk not in seen:
            seen.add(tk); tks.append(tk)
    tks = tks[:4]
    if not tks:
        return jsonify({"items": []})
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as ex:
        items = list(ex.map(_holding_metrics, tks))
    return jsonify({"items": items})


# Screener
# Liquid IDX stocks, curated across sectors; not the whole exchange.
SCREEN_UNIVERSE = [
    "BBCA", "BBRI", "BMRI", "BBNI", "BRIS", "BBTN", "ARTO",
    "TLKM", "ISAT", "EXCL", "TOWR", "MTEL",
    "ASII", "UNTR", "ADRO", "PTBA", "ITMG", "PGAS", "MEDC", "ANTM", "INCO", "TINS", "HRUM",
    "UNVR", "ICBP", "INDF", "MYOR", "GGRM", "HMSP", "AMRT", "CPIN", "JPFA",
    "SMGR", "INTP", "JSMR", "BSDE", "CTRA", "PWON",
    "KLBF", "SIDO", "MIKA", "ACES", "ERAA", "MAPI", "AKRA", "GOTO", "BUKA",
]


def _fund_score(per, pbv, roe, dy, upside):
    s = 0.0
    if roe:
        s += min(max(roe, 0) / 25, 1) * 30
    if per and per > 0:
        s += max(0, min((25 - per) / 25, 1)) * 25
    if pbv and pbv > 0:
        s += max(0, min((3 - pbv) / 3, 1)) * 20
    if dy:
        s += min(max(dy, 0) / 8, 1) * 15
    if upside:
        s += max(0, min(upside / 50, 1)) * 10
    return s


def _screen_metrics():
    def scan():
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=10) as ex:
            found = [m for m in ex.map(lambda t: _holding_metrics(t + ".JK"), SCREEN_UNIVERSE) if m and not m.get("error")]
        return found, True
    return _compute_once("screen:all", scan)


@app.route("/api/screener", methods=["POST"])
def api_screener():
    body = _json_object()
    if body is None:
        return _bad_body()
    raw_filters = body.get("filters", {})
    raw_filters = raw_filters if isinstance(raw_filters, dict) else {}
    f = {k: _num(raw_filters.get(k)) for k in ("perMax", "pbvMax", "roeMin", "dyMin")}
    f["sector"] = str(raw_filters.get("sector") or "")
    metrics = _screen_metrics()
    results = []
    for m in metrics:
        per, pbv, roe = m.get("per"), m.get("pbv"), m.get("roe")
        dy, price, tgt = m.get("dividendYield"), m.get("price"), m.get("targetMean")
        if f.get("perMax") and (per is None or per <= 0 or per > f["perMax"]):
            continue
        if f.get("pbvMax") and (pbv is None or pbv <= 0 or pbv > f["pbvMax"]):
            continue
        if f.get("roeMin") and (roe is None or roe < f["roeMin"]):
            continue
        if f.get("dyMin") and (dy is None or dy < f["dyMin"]):
            continue
        if f.get("sector") and (m.get("sector") or "") != f["sector"]:
            continue
        upside = ((tgt - price) / price * 100) if (tgt and price) else None
        results.append({**m, "targetUpside": upside, "scoreFund": round(_fund_score(per, pbv, roe, dy, upside), 1)})
    results.sort(key=lambda x: -x["scoreFund"])
    sectors = sorted({m.get("sector") for m in metrics if m.get("sector")})
    return jsonify({"count": len(results), "universe": len(metrics),
                    "results": results[:60], "sectors": sectors})


# Pasar (IHSG, emas, FX)
MARKET_INSTRUMENTS = [
    {"symbol": "^JKSE", "name": "IHSG"},
    {"symbol": "GC=F", "name": "Emas (USD/oz)"},
    {"symbol": "IDR=X", "name": "USD / IDR"},
    {"symbol": "EURIDR=X", "name": "EUR / IDR"},
    {"symbol": "AUDIDR=X", "name": "AUD / IDR"},
    {"symbol": "SGDIDR=X", "name": "SGD / IDR"},
    {"symbol": "MYRIDR=X", "name": "MYR / IDR"},
]


def _market_quote(sym: str) -> dict:
    try:
        h = yf.Ticker(sym).history(period="5d", interval="1d", timeout=_YF_TIMEOUT)
        if h is None or h.empty:
            return {"symbol": sym, "error": True}
        h = h.dropna(subset=["Close"])
        last = float(h["Close"].iloc[-1])
        prev = float(h["Close"].iloc[-2]) if len(h) > 1 else last
        return {"symbol": sym, "price": last, "changePct": round((last - prev) / prev * 100 if prev else 0, 2)}
    except Exception:  # noqa: BLE001
        return {"symbol": sym, "error": True}


@app.route("/api/market")
def api_market():
    cached = _cache_get("market:quotes")
    if cached is not None:
        return jsonify(cached)
    from concurrent.futures import ThreadPoolExecutor
    syms = [i["symbol"] for i in MARKET_INSTRUMENTS]
    with ThreadPoolExecutor(max_workers=8) as ex:
        qmap = {q["symbol"]: q for q in ex.map(_market_quote, syms)}
    items = [{**i, **qmap.get(i["symbol"], {})} for i in MARKET_INSTRUMENTS]
    res = {"items": items}
    _cache_set("market:quotes", res)
    return jsonify(res)


RUPIAH_INSTRUMENTS = [
    {"symbol": "IDR=X", "name": "USD / IDR"},
    {"symbol": "EURIDR=X", "name": "EUR / IDR"},
    {"symbol": "SGDIDR=X", "name": "SGD / IDR"},
    {"symbol": "JPYIDR=X", "name": "JPY / IDR"},
    {"symbol": "AUDIDR=X", "name": "AUD / IDR"},
    {"symbol": "GBPIDR=X", "name": "GBP / IDR"},
    {"symbol": "CNYIDR=X", "name": "CNY / IDR"},
    {"symbol": "MYRIDR=X", "name": "MYR / IDR"},
    {"symbol": "DX-Y.NYB", "name": "Dollar Index (DXY)"},
]


@app.route("/api/rupiah")
def api_rupiah():
    cached = _cache_get("rupiah:quotes")
    if cached is not None:
        return jsonify(cached)
    from concurrent.futures import ThreadPoolExecutor
    syms = [i["symbol"] for i in RUPIAH_INSTRUMENTS]
    with ThreadPoolExecutor(max_workers=8) as ex:
        qmap = {q["symbol"]: q for q in ex.map(_market_quote, syms)}
    items = [{**i, **qmap.get(i["symbol"], {})} for i in RUPIAH_INSTRUMENTS]
    res = {"items": items, "chartSymbol": "IDR=X", "chartName": "USD / IDR"}
    _cache_set("rupiah:quotes", res)
    return jsonify(res)


@app.route("/api/gold")
def api_gold():
    cached = _cache_get("gold:quotes")
    if cached is not None:
        return jsonify(cached)
    from concurrent.futures import ThreadPoolExecutor
    syms = ["GC=F", "SI=F", "IDR=X"]
    with ThreadPoolExecutor(max_workers=3) as ex:
        q = {r["symbol"]: r for r in ex.map(_market_quote, syms)}
    gold = q.get("GC=F", {})
    silver = q.get("SI=F", {})
    usdidr = (q.get("IDR=X", {}) or {}).get("price")
    OZ_G = 31.1034768
    items = []
    fx_change = (q.get("IDR=X", {}) or {}).get("changePct")

    def in_rupiah(change: Optional[float]) -> Optional[float]:
        """Rupiah price change combines the USD move and the USD/IDR move."""
        if change is None or fx_change is None:
            return None
        return round(((1 + change / 100) * (1 + fx_change / 100) - 1) * 100, 2)

    gp, gc = gold.get("price"), gold.get("changePct")
    if gp:
        items.append({"name": "Emas (USD / oz)", "price": gp, "changePct": gc, "symbol": "GC=F"})
        if usdidr:
            items.append({"name": "Emas (IDR / gram)", "price": round(gp * usdidr / OZ_G), "changePct": in_rupiah(gc)})
            items.append({"name": "Emas (IDR / oz)", "price": round(gp * usdidr), "changePct": in_rupiah(gc)})
    sp, sc = silver.get("price"), silver.get("changePct")
    if sp:
        items.append({"name": "Perak (USD / oz)", "price": sp, "changePct": sc, "symbol": "SI=F"})
        if usdidr:
            items.append({"name": "Perak (IDR / gram)", "price": round(sp * usdidr / OZ_G), "changePct": in_rupiah(sc)})
    if usdidr:
        items.append({"name": "USD / IDR", "price": usdidr, "changePct": fx_change, "symbol": "IDR=X"})
    if gp and sp:
        items.append({"name": "Rasio Emas/Perak", "price": round(gp / sp, 1), "changePct": None})
    res = {"items": items, "chartSymbol": "GC=F", "chartName": "Emas (USD/oz)"}
    _cache_set("gold:quotes", res)
    return jsonify(res)


_MARKET_CHART_FRAMES = {
    "1mo": {"1d"}, "6mo": {"1d"}, "1y": {"1d"},
    "2y": {"1wk"}, "5y": {"1wk"}, "max": {"1mo"},
}
_MARKET_SYMBOLS = (
    {i["symbol"] for i in MARKET_INSTRUMENTS}
    | {i["symbol"] for i in RUPIAH_INSTRUMENTS}
    | {"GC=F", "SI=F"}
)


@app.route("/api/marketchart/<path:symbol>")
def api_marketchart(symbol):
    rng = request.args.get("range", "1y")
    interval = request.args.get("interval", "1d")
    if symbol not in _MARKET_SYMBOLS:
        return jsonify({"error": "Instrumen tidak dikenal.", "chart": {"candles": []}}), 400
    if interval not in _MARKET_CHART_FRAMES.get(rng, set()):
        return jsonify({"error": "Rentang grafik tidak valid.", "chart": {"candles": []}}), 400
    key = f"mktc:{symbol}:{rng}:{interval}"
    cached = _cache_get(key)
    if cached is not None:
        return jsonify(cached)
    try:
        h = yf.Ticker(symbol).history(period=rng, interval=interval, auto_adjust=False, timeout=_YF_TIMEOUT)
        if h is None or h.empty:
            return jsonify({"error": "Data grafik kosong.", "chart": {"candles": []}}), 404
        h = h.dropna(subset=["Close"])
        res = {"symbol": symbol, "chart": ind.series_for_chart(h, intraday=False)}
        _cache_set(key, res)
        return jsonify(res)
    except Exception:  # noqa: BLE001
        logger.warning("Market chart unavailable for %s", symbol)
        return jsonify({"error": "Data pasar sementara tidak tersedia.", "chart": {"candles": []}}), 502


def _limit_arg(default: int, ceiling: int = 50) -> int:
    try:
        value = int(request.args.get("limit", default))
    except (TypeError, ValueError):
        return default
    return max(1, min(value, ceiling))


# News
_NEWS_REFRESH_GAP = 30
_news_refreshed: dict[str, float] = {}


def _news_response(key: str, fetch):
    """Serve news from cache; ``fresh=1`` bypasses it at most once per 30 s per key."""
    cached = _cache_get(key)
    fresh = bool(request.args.get("fresh"))
    if fresh and time.monotonic() - _news_refreshed.get(key, 0.0) < _NEWS_REFRESH_GAP:
        fresh = False
    if cached is not None and not fresh:
        return jsonify(cached)
    if fresh:
        _news_refreshed[key] = time.monotonic()
    data = fetch()
    if data.get("items"):
        _cache_set(key, data)
    elif cached is not None:
        return jsonify(cached)
    return jsonify(data)


@app.route("/api/news/market")
def api_news_market():
    limit = _limit_arg(25)
    return _news_response(f"news:market:{limit}", lambda: news_mod.market_news(limit=limit))


@app.route("/api/news/stock/<ticker>")
def api_news_stock(ticker):
    tk = normalize(ticker)
    if not tk:
        return jsonify({"query": "", "count": 0, "items": []}), 400
    limit = _limit_arg(15)
    return _news_response(f"news:{tk}:{limit}", lambda: news_mod.stock_news(tk, limit=limit))


# AI (optional)
@app.route("/api/ai/status")
def api_ai_status():
    return jsonify(ai_mod.status())


@app.route("/api/ai/toggle", methods=["POST"])
def api_ai_toggle():
    body = _json_object()
    if body is None:
        return _bad_body()
    ai_mod.set_mode(bool(body.get("on")))
    return jsonify(ai_mod.status())


@app.route("/api/ai/analyze", methods=["POST"])
def api_ai_analyze():
    body = _json_object()
    if body is None:
        return _bad_body()
    context = body.get("context") or {}
    question = body.get("question")
    if question is not None and not isinstance(question, str):
        return jsonify({"error": "Pertanyaan harus berupa teks."}), 400
    question = (question or "").strip()[:1000] or None
    if not isinstance(context, dict) or not context:
        return jsonify({"error": "Data saham belum dimuat."}), 400
    try:
        return jsonify(ai_mod.analyze(context, question))
    except Exception:  # noqa: BLE001
        logger.exception("AI analyze endpoint failed")
        return jsonify({"error": "Analisis AI gagal. Coba lagi nanti.", "enabled": ai_mod.is_enabled()}), 502


@app.route("/api/ai/news", methods=["POST"])
def api_ai_news():
    body = _json_object()
    if body is None:
        return _bad_body()
    items = body.get("items") or []
    scope = str(body.get("scope") or "pasar")[:60]
    if not isinstance(items, list):
        return jsonify({"error": "Format berita tidak valid."}), 400
    items = [item for item in items if isinstance(item, dict)]
    try:
        return jsonify(ai_mod.news_brief(items, scope))
    except Exception:  # noqa: BLE001
        logger.exception("AI news endpoint failed")
        return jsonify({"error": "Ringkasan AI gagal. Coba lagi nanti.", "enabled": ai_mod.is_enabled()}), 502


_MDNS_NAME_RE = re.compile(r"[a-z0-9-]{1,63}")


def _mdns_name() -> str:
    """The mDNS host name from MDNS_NAME (lower-cased); empty means mDNS is off."""
    raw = os.environ.get("MDNS_NAME", "").strip().lower()
    if raw and not _MDNS_NAME_RE.fullmatch(raw):
        logger.warning("MDNS_NAME ignored: use 1-63 letters, digits or hyphens")
        return ""
    return raw


def _lan_ip() -> str:
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:  # noqa: BLE001
        return "127.0.0.1"


def _start_mdns(ip: str, port: int, name: str):
    """Advertise http://<name>.local on the LAN; returns the Zeroconf handle or None."""
    try:
        import socket
        from zeroconf import Zeroconf, ServiceInfo
    except ImportError:
        print("  (mDNS is off: install the optional zeroconf package to use MDNS_NAME.)")
        return None
    try:
        zc = Zeroconf()
        zc.register_service(ServiceInfo(
            "_http._tcp.local.",
            f"{name}._http._tcp.local.",
            addresses=[socket.inet_aton(ip)],
            port=port,
            server=f"{name}.local.",
            properties={},
        ))
        return zc
    except Exception:  # noqa: BLE001
        logger.warning("mDNS registration failed", exc_info=True)
        return None


def _stop_mdns(zc) -> None:
    try:
        zc.unregister_all_services()
        zc.close()
    except Exception:  # noqa: BLE001
        logger.debug("mDNS shutdown failed", exc_info=True)


_LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def _serve_settings() -> tuple[str, int, bool]:
    """Host, port and whether to open a browser, from the environment.

    The default host is 127.0.0.1, so only this computer can connect until the
    owner sets FLASK_HOST=0.0.0.0.
    """
    host = os.environ.get("FLASK_HOST", "").strip() or "127.0.0.1"
    try:
        port = int(os.environ.get("FLASK_PORT", "").strip() or "5000")
        if not 0 < port < 65536:
            raise ValueError
    except ValueError:
        port = 5000
    open_browser = os.environ.get("OPEN_BROWSER", "").strip().lower() not in {"0", "false", "no", "off"}
    return host, port, open_browser


def _start_url(port: int) -> str:
    """The address to open on this computer; carries the setup code on a fresh install."""
    base = f"http://127.0.0.1:{port}/"
    return base if _owner_configured() else f"{base}#setup={_setup_code()}"


def _print_banner(host: str, port: int, ip: str, mdns_url: Optional[str]) -> None:
    ai = ai_mod.status()
    print(f"\n  {_app_name()} · {APP_CREDIT} · v{APP_VERSION}")
    print(f"  On this computer : http://127.0.0.1:{port}")
    if not _owner_configured():
        print(f"  First-run code   : {_setup_code()}   (enter it on the setup page)")
    if host in _LOCAL_HOSTS:
        print("  Other devices    : off (set FLASK_HOST=0.0.0.0 in .env to use it from a phone)")
    else:
        print(f"  Other devices    : http://{ip}:{port}")
        if mdns_url:
            print(f"  Local name       : {mdns_url}")
    print(f"  Data folder      : {_DATA_DIR}")
    ai_text = f"{ai.get('model') or '-'} via {ai.get('provider')}" if ai.get("enabled") else "off"
    print(f"  AI               : {ai_text}")
    print(f"  Admin password   : {'set' if is_admin_password_set() else 'not set (MASTER_ADMIN_PASSWORD)'}")
    print()


def _bind_server_socket(host: str, port: int):
    """Bind the listening socket before Waitress starts, refusing a busy port.

    Waitress's own bind sets SO_REUSEADDR, which on Windows lets a second
    server share a port that is already in use. socket.create_server sets it
    only on POSIX, where it just allows a quick restart.

    Raises:
        OSError: when the address is in use or does not belong to this computer.
    """
    import socket

    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    return socket.create_server((host, port), family=family)


def main() -> int:
    """Serve with Waitress, holding the data folder's single-instance lock."""
    import webbrowser
    from waitress import serve

    host, port, open_browser = _serve_settings()
    lock = _acquire_instance_lock(os.path.join(_DATA_DIR, ".lock"))
    if lock is None:
        print(f"\n  Another server is already using {_DATA_DIR}. Close it first, then start again.\n")
        return 1
    try:
        sock = _bind_server_socket(host, port)
    except OSError:
        _release_instance_lock(lock)
        print(f"\n  Cannot listen on {host}:{port}: the port is in use, or the address is not on this computer.\n"
              "  Close the other program, or set FLASK_PORT (or FLASK_HOST) in .env.\n")
        return 1
    lan = host not in _LOCAL_HOSTS
    ip = _lan_ip() if lan else "127.0.0.1"
    mdns_name = _mdns_name() if lan else ""
    zc = _start_mdns(ip, port, mdns_name) if mdns_name and not ip.startswith("127.") else None
    _print_banner(host, port, ip, f"http://{mdns_name}.local:{port}" if zc else None)
    if open_browser:
        threading.Timer(1.0, webbrowser.open, args=(_start_url(port),)).start()
    try:
        serve(app, sockets=[sock], threads=8)
    finally:
        if zc is not None:
            _stop_mdns(zc)
        sock.close()
        _release_instance_lock(lock)
    return 0


if __name__ == "__main__":
    sys.exit(main())
