"""Client-side defaults on the WireGuard core.

DNS is not cosmetic here: with the usual full-tunnel AllowedIPs, a generated
config with no DNS resolves nothing, so only apps carrying hardcoded server IPs
(Telegram) keep working and the tunnel reads as half-broken. The core supplies
the default; a host override wins when it is set.
"""

import pytest

from app.core.wireguard import _validate_dns, _validate_keepalive, _validate_mtu


class TestDNS:
    @pytest.mark.parametrize("raw", [None, "", []])
    def test_absent_means_no_dns_line(self, raw):
        assert _validate_dns(raw) == []

    def test_list_is_normalised(self):
        assert _validate_dns([" 8.8.8.8 ", "8.8.4.4"]) == ["8.8.8.8", "8.8.4.4"]

    def test_comma_or_space_separated_string_is_accepted(self):
        assert _validate_dns("8.8.8.8, 8.8.4.4") == ["8.8.8.8", "8.8.4.4"]
        assert _validate_dns("1.1.1.1 1.0.0.1") == ["1.1.1.1", "1.0.0.1"]

    def test_duplicates_are_collapsed(self):
        assert _validate_dns(["8.8.8.8", "8.8.8.8"]) == ["8.8.8.8"]

    def test_ipv6_is_allowed(self):
        assert _validate_dns(["2001:4860:4860::8888"]) == ["2001:4860:4860::8888"]

    @pytest.mark.parametrize("bad", [["not-an-ip"], ["8.8.8"], ["example.com"], [""], [5], 42])
    def test_invalid_entries_are_rejected(self, bad):
        with pytest.raises(ValueError):
            _validate_dns(bad)


class TestKeepalive:
    @pytest.mark.parametrize("raw", [None, "", 0, "0"])
    def test_absent_means_client_decides(self, raw):
        assert _validate_keepalive(raw) == 0

    def test_value_is_normalised_to_int(self):
        assert _validate_keepalive("25") == 25

    @pytest.mark.parametrize("bad", [-1, 121, "abc", True, [25]])
    def test_out_of_range_or_wrong_type_is_rejected(self, bad):
        with pytest.raises(ValueError):
            _validate_keepalive(bad)


class TestMTU:
    @pytest.mark.parametrize("raw", [None, "", 0, "0"])
    def test_absent_leaves_the_line_out(self, raw):
        assert _validate_mtu(raw) == 0

    def test_value_is_normalised_to_int(self):
        assert _validate_mtu("1280") == 1280

    @pytest.mark.parametrize("bad", [575, 1501, "abc", True, [1280]])
    def test_out_of_range_or_wrong_type_is_rejected(self, bad):
        with pytest.raises(ValueError):
            _validate_mtu(bad)
