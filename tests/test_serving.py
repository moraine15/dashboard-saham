"""Serving defaults for a self-hosted install: host, port, data folder, mDNS, launch."""
import os
import unittest
from unittest.mock import MagicMock, patch

import app as dashboard


class ServeSettingsTest(unittest.TestCase):
    def test_defaults_are_local_only(self):
        with patch.dict(os.environ, {"FLASK_HOST": "", "FLASK_PORT": "", "OPEN_BROWSER": ""}):
            self.assertEqual(dashboard._serve_settings(), ("127.0.0.1", 5000, True))

    def test_environment_overrides(self):
        with patch.dict(os.environ, {"FLASK_HOST": "0.0.0.0", "FLASK_PORT": "8080", "OPEN_BROWSER": "0"}):
            self.assertEqual(dashboard._serve_settings(), ("0.0.0.0", 8080, False))

    def test_bad_port_falls_back(self):
        for value in ("abc", "0", "70000"):
            with self.subTest(port=value), patch.dict(os.environ, {"FLASK_PORT": value}):
                self.assertEqual(dashboard._serve_settings()[1], 5000)

    def test_mdns_names_are_validated(self):
        cases = {"": "", "Saham-Rumah": "saham-rumah", "bad name": "", "x" * 64: ""}
        for raw, expected in cases.items():
            with self.subTest(name=raw[:10]), patch.dict(os.environ, {"MDNS_NAME": raw}):
                self.assertEqual(dashboard._mdns_name(), expected)

    def test_data_dir_resolution(self):
        base = dashboard._BASE_DIR
        self.assertEqual(dashboard._resolve_data_dir(None), os.path.join(base, "data"))
        self.assertEqual(dashboard._resolve_data_dir("  "), os.path.join(base, "data"))
        self.assertEqual(dashboard._resolve_data_dir("simpanan"), os.path.join(base, "simpanan"))
        absolute = os.path.abspath(os.sep + "srv-data")
        self.assertEqual(dashboard._resolve_data_dir(absolute), absolute)

    def test_start_url_carries_the_setup_code_until_an_owner_exists(self):
        with patch.object(dashboard, "_owner_configured", return_value=False):
            self.assertTrue(dashboard._start_url(5000).startswith("http://127.0.0.1:5000/#setup="))
        with patch.object(dashboard, "_owner_configured", return_value=True):
            self.assertEqual(dashboard._start_url(5000), "http://127.0.0.1:5000/")


class BindTest(unittest.TestCase):
    def test_a_busy_port_is_refused_not_shared(self):
        # Waitress's own bind sets SO_REUSEADDR, which on Windows let a second
        # server answer on the same port as the first.
        first = dashboard._bind_server_socket("127.0.0.1", 0)
        try:
            port = first.getsockname()[1]
            with self.assertRaises(OSError):
                dashboard._bind_server_socket("127.0.0.1", port).close()
        finally:
            first.close()


class MainTest(unittest.TestCase):
    ENV = {"FLASK_HOST": "", "FLASK_PORT": "", "OPEN_BROWSER": "0", "MDNS_NAME": ""}

    def test_main_serves_with_waitress_and_holds_the_lock(self):
        calls = {}
        sock = MagicMock()
        with patch.dict(os.environ, self.ENV), \
                patch("waitress.serve", side_effect=lambda app, **kw: calls.update(kw)), \
                patch.object(dashboard, "_bind_server_socket", return_value=sock) as bind, \
                patch.object(dashboard, "_acquire_instance_lock", return_value=object()) as lock, \
                patch.object(dashboard, "_release_instance_lock") as release, \
                patch("builtins.print"):
            self.assertEqual(dashboard.main(), 0)
        bind.assert_called_once_with("127.0.0.1", 5000)
        self.assertEqual(calls, {"sockets": [sock], "threads": 8})
        lock.assert_called_once()
        release.assert_called_once()
        sock.close.assert_called_once()

    def test_main_reports_a_busy_port_and_opens_no_browser(self):
        printed = []
        with patch.dict(os.environ, dict(self.ENV, OPEN_BROWSER="1")), patch("waitress.serve") as serve, \
                patch.object(dashboard, "_bind_server_socket", side_effect=OSError("in use")), \
                patch.object(dashboard, "_acquire_instance_lock", return_value=object()), \
                patch.object(dashboard, "_release_instance_lock") as release, \
                patch("threading.Timer") as timer, \
                patch("builtins.print", side_effect=lambda *a, **k: printed.append(" ".join(map(str, a)))):
            self.assertEqual(dashboard.main(), 1)
        serve.assert_not_called()
        timer.assert_not_called()
        release.assert_called_once()
        self.assertTrue(any("5000" in line and "FLASK_PORT" in line for line in printed), printed)

    def test_main_refuses_a_second_instance(self):
        with patch.dict(os.environ, self.ENV), patch("waitress.serve") as serve, \
                patch.object(dashboard, "_acquire_instance_lock", return_value=None), \
                patch("builtins.print"):
            self.assertEqual(dashboard.main(), 1)
        serve.assert_not_called()


if __name__ == "__main__":
    unittest.main()
