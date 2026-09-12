#!/bin/sh
# Offline contract tests for the fail-closed install.sh.
#
# Every case builds a fixture "release" on local disk and points the installer
# at it with PRVIEW_BASE_URL=file://... (curl speaks file://). Nothing here
# touches the network or downloads a real release.
#
# A fake `cargo` that writes a marker file sits first on PATH for every run:
# if the installer ever executes cargo, the marker appears and the suite fails.
#
# Usage: sh tools/tests/test_install.sh
set -u

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/../.." && pwd)
INSTALL_SH="${REPO_ROOT}/install.sh"

TAG="v9.9.9"
VERSION="9.9.9"
GOOD_SHA="0123456789abcdef0123456789abcdef01234567"
LINUX_TARGET="x86_64-unknown-linux-gnu"
DARWIN_TARGET="aarch64-apple-darwin"

HOST_OS=$(uname -s)
HOST_ARCH=$(uname -m)

WORK=$(mktemp -d)
CARGO_MARKER="${WORK}/cargo-was-invoked"
FAKE_BIN="${WORK}/fakebin"
SERVER_PID=""

PASS=0
FAIL=0
SKIP=0
CASE_N=0

# shellcheck disable=SC2329  # invoked by trap
cleanup() {
	if [ -n "${SERVER_PID}" ]; then
		kill "${SERVER_PID}" 2>/dev/null || true
		wait "${SERVER_PID}" 2>/dev/null || true
	fi
	rm -rf "${WORK}"
}
trap cleanup EXIT INT TERM

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | awk '{print $1}'
	else
		shasum -a 256 "$1" | awk '{print $1}'
	fi
}

mkdir -p "${FAKE_BIN}"
cat >"${FAKE_BIN}/cargo" <<EOF
#!/bin/sh
printf 'cargo invoked with: %s\n' "\$*" >>"${CARGO_MARKER}"
exit 0
EOF
chmod 755 "${FAKE_BIN}/cargo"
cp "${FAKE_BIN}/cargo" "${FAKE_BIN}/rustup"
PATH="${FAKE_BIN}:${PATH}"
export PATH

# write_fake_prview <path> <version-line> <source-sha>
write_fake_prview() {
	cat >"$1" <<EOF
#!/bin/sh
case "\$1" in
	--version) printf 'prview %s\n' '$2' ;;
	--build-source-sha) printf '%s\n' '$3' ;;
	*) printf 'fake prview\n' ;;
esac
EOF
	chmod 755 "$1"
}

# make_fixture <name> <target> <variant> -> prints fixture root
#
# Layout mirrors GitHub: <root>/download/<tag>/<asset> and a <root>/latest/VERSION
# tag marker standing in for the releases/latest redirect (file:// cannot redirect;
# the redirect path itself is covered by the http-redirect case below).
make_fixture() {
	name=$1
	target=$2
	variant=$3

	root="${WORK}/fixtures/${name}"
	rel="${root}/download/${TAG}"
	stage="${WORK}/stage/${name}"
	mkdir -p "${rel}" "${root}/latest" "${stage}"
	printf '%s\n' "${TAG}" >"${root}/latest/VERSION"

	archive="prview-${target}.tar.gz"

	case "${variant}" in
		badversion) write_fake_prview "${stage}/prview" "1.2.3" "${GOOD_SHA}" ;;
		unknownsha) write_fake_prview "${stage}/prview" "${VERSION}" "unknown" ;;
		*) write_fake_prview "${stage}/prview" "${VERSION}" "${GOOD_SHA}" ;;
	esac

	case "${variant}" in
		extrafile)
			printf 'README\n' >"${stage}/README.md"
			(cd "${stage}" && tar czf "${rel}/${archive}" prview README.md)
			;;
		traversal)
			python3 - "${stage}/prview" "${rel}/${archive}" <<'PY'
import sys, tarfile
src, dest = sys.argv[1], sys.argv[2]
with tarfile.open(dest, "w:gz") as tf:
    tf.add(src, arcname="../prview")
PY
			;;
		noarchive)
			: # deliberately no archive at all
			;;
		*)
			(cd "${stage}" && tar czf "${rel}/${archive}" prview)
			;;
	esac

	# SHA256SUMS
	case "${variant}" in
		badsum)
			printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "${archive}" >"${rel}/SHA256SUMS"
			;;
		nosumentry)
			printf '%s  %s\n' "$(sha256_of "${rel}/${archive}")" "prview-some-other-target.tar.gz" >"${rel}/SHA256SUMS"
			;;
		emptysums)
			: >"${rel}/SHA256SUMS"
			;;
		noarchive)
			printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "${archive}" >"${rel}/SHA256SUMS"
			;;
		*)
			printf '%s  %s\n' "$(sha256_of "${rel}/${archive}")" "${archive}" >"${rel}/SHA256SUMS"
			;;
	esac

	printf '%s\n' "${root}"
}

# run_case <name> <expected-exit> <expected-substring> <env-assignments...> --
# Remaining arguments after `--` are ignored; the installer is always invoked
# as `sh install.sh` with the given environment.
run_case() {
	name=$1
	expected_code=$2
	expected_msg=$3
	shift 3

	CASE_N=$((CASE_N + 1))
	out="${WORK}/out.${CASE_N}"

	env "$@" sh "${INSTALL_SH}" >"${out}" 2>&1
	code=$?

	ok=1
	if [ "${code}" != "${expected_code}" ]; then
		ok=0
		reason="exit ${code}, expected ${expected_code}"
	elif ! grep -qF "${expected_msg}" "${out}"; then
		ok=0
		reason="message '${expected_msg}' not found"
	fi

	if [ "${ok}" = "1" ]; then
		PASS=$((PASS + 1))
		printf 'PASS  [exit %s] %s\n' "${code}" "${name}"
	else
		FAIL=$((FAIL + 1))
		printf 'FAIL  [exit %s] %s (%s)\n' "${code}" "${name}" "${reason}"
		sed 's/^/      | /' "${out}"
	fi
}

skip_case() {
	SKIP=$((SKIP + 1))
	printf 'SKIP  %s (%s)\n' "$1" "$2"
}

assert_true() {
	if [ "$2" = "1" ]; then
		PASS=$((PASS + 1))
		printf 'PASS  %s\n' "$1"
	else
		FAIL=$((FAIL + 1))
		printf 'FAIL  %s\n' "$1"
	fi
}

printf 'install.sh offline contract tests (host %s/%s)\n\n' "${HOST_OS}" "${HOST_ARCH}"

# --- 1. happy path, `latest` resolved from the tag marker ---------------------
fx=$(make_fixture happy "${LINUX_TARGET}" good)
dest="${WORK}/dest-happy"
run_case "happy path: latest resolves, verifies, installs" 0 "prview 9.9.9 installed to" \
	PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=x86_64 \
	PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${dest}"

installed_ok=0
if [ -x "${dest}/prview" ] && [ "$("${dest}/prview" --version)" = "prview ${VERSION}" ]; then
	installed_ok=1
fi
assert_true "happy path: binary present and runnable at install dir" "${installed_ok}"

sha_reported=0
grep -qF "source commit: ${GOOD_SHA}" "${WORK}/out.1" && sha_reported=1
assert_true "happy path: reports the 40-hex build source commit" "${sha_reported}"

# --- 2. explicit version ------------------------------------------------------
run_case "explicit PRVIEW_VERSION=9.9.9 installs without resolving latest" 0 "prview 9.9.9 installed to" \
	PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=x86_64 PRVIEW_VERSION="${VERSION}" \
	PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-explicit"

# --- 3. checksum mismatch -----------------------------------------------------
fx=$(make_fixture badsum "${LINUX_TARGET}" badsum)
run_case "checksum mismatch is rejected" 4 "checksum mismatch for prview-${LINUX_TARGET}.tar.gz" \
	PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=x86_64 PRVIEW_VERSION="${VERSION}" \
	PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-badsum"

badsum_absent=0
[ ! -e "${WORK}/dest-badsum/prview" ] && badsum_absent=1
assert_true "checksum mismatch installs nothing" "${badsum_absent}"

# --- 4. missing archive -------------------------------------------------------
fx=$(make_fixture noarchive "${LINUX_TARGET}" noarchive)
run_case "missing release archive is rejected" 3 "no official artifact for ${LINUX_TARGET}" \
	PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=x86_64 PRVIEW_VERSION="${VERSION}" \
	PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-noarchive"

# --- 5. SHA256SUMS without an entry for the archive ---------------------------
fx=$(make_fixture nosumentry "${LINUX_TARGET}" nosumentry)
run_case "SHA256SUMS without a matching entry is rejected" 4 "has 0 entries for prview-${LINUX_TARGET}.tar.gz" \
	PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=x86_64 PRVIEW_VERSION="${VERSION}" \
	PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-nosumentry"

# --- 6. empty SHA256SUMS ------------------------------------------------------
fx=$(make_fixture emptysums "${LINUX_TARGET}" emptysums)
run_case "empty SHA256SUMS is rejected" 4 "is empty or missing" \
	PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=x86_64 PRVIEW_VERSION="${VERSION}" \
	PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-emptysums"

# --- 7. archive with an extra file -------------------------------------------
fx=$(make_fixture extrafile "${LINUX_TARGET}" extrafile)
run_case "archive with an extra file is rejected" 4 "must contain exactly one entry named 'prview'" \
	PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=x86_64 PRVIEW_VERSION="${VERSION}" \
	PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-extrafile"

# --- 8. archive with a ../ traversal path ------------------------------------
if command -v python3 >/dev/null 2>&1; then
	fx=$(make_fixture traversal "${LINUX_TARGET}" traversal)
	run_case "archive with a ../ path is rejected" 4 "must contain exactly one entry named 'prview'" \
		PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=x86_64 PRVIEW_VERSION="${VERSION}" \
		PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-traversal"
else
	skip_case "archive with a ../ path is rejected" "python3 not available to craft the archive"
fi

# --- 9/10. unsupported platforms ---------------------------------------------
fx=$(make_fixture unsupported "${LINUX_TARGET}" good)
run_case "unsupported Linux/riscv64 fails closed" 2 "unsupported platform Linux/riscv64" \
	PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=riscv64 \
	PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-riscv"

run_case "unsupported Darwin/x86_64 fails closed" 2 "unsupported platform Darwin/x86_64" \
	PRVIEW_TEST_UNAME_S=Darwin PRVIEW_TEST_UNAME_M=x86_64 \
	PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-intelmac"

cargo_clean=0
[ ! -e "${CARGO_MARKER}" ] && cargo_clean=1
assert_true "no cargo fallback: fake cargo first on PATH was never invoked" "${cargo_clean}"

# --- 11. post-install version mismatch ---------------------------------------
fx=$(make_fixture badversion "${LINUX_TARGET}" badversion)
run_case "binary reporting the wrong version is rejected" 6 "version mismatch" \
	PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=x86_64 PRVIEW_VERSION="${VERSION}" \
	PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-badversion"

badversion_absent=0
[ ! -e "${WORK}/dest-badversion/prview" ] && badversion_absent=1
assert_true "version mismatch installs nothing" "${badversion_absent}"

# --- 12. unknown build provenance --------------------------------------------
fx=$(make_fixture unknownsha "${LINUX_TARGET}" unknownsha)
run_case "binary with --build-source-sha=unknown is rejected" 6 "build provenance missing" \
	PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=x86_64 PRVIEW_VERSION="${VERSION}" \
	PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-unknownsha"

# --- 13. macOS: unsigned binary must be rejected ------------------------------
case "${HOST_OS}/${HOST_ARCH}" in
	Darwin/arm64 | Darwin/aarch64)
		fx=$(make_fixture macos "${DARWIN_TARGET}" good)
		run_case "macOS: unsigned binary is rejected (no bypass)" 5 "macOS code signature verification failed" \
			PRVIEW_VERSION="${VERSION}" \
			PRVIEW_BASE_URL="file://${fx}" PRVIEW_INSTALL_DIR="${WORK}/dest-macos"

		macos_absent=0
		[ ! -e "${WORK}/dest-macos/prview" ] && macos_absent=1
		assert_true "macOS: unsigned binary installs nothing" "${macos_absent}"
		;;
	*)
		skip_case "macOS: unsigned binary is rejected (no bypass)" "host is not arm64 macOS"
		;;
esac

# --- 14. `latest` resolved through a real HTTP redirect -----------------------
if command -v python3 >/dev/null 2>&1; then
	fx=$(make_fixture redirect "${LINUX_TARGET}" good)
	cat >"${WORK}/server.py" <<'PY'
import http.server, sys

root = sys.argv[1]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=root, **kw)

    def do_GET(self):
        if self.path == "/latest":
            self.send_response(302)
            self.send_header("Location", "/tag/v9.9.9")
            self.end_headers()
            return
        super().do_GET()

    def log_message(self, *a):
        pass


server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
PY
	python3 "${WORK}/server.py" "${fx}" >"${WORK}/port.txt" 2>/dev/null &
	SERVER_PID=$!
	port=""
	i=0
	while [ "${i}" -lt 50 ]; do
		port=$(cat "${WORK}/port.txt" 2>/dev/null | head -1)
		[ -n "${port}" ] && break
		i=$((i + 1))
		sleep 0.1
	done
	if [ -n "${port}" ]; then
		run_case "latest resolved through an HTTP 302 redirect" 0 "prview 9.9.9 installed to" \
			PRVIEW_TEST_UNAME_S=Linux PRVIEW_TEST_UNAME_M=x86_64 \
			PRVIEW_BASE_URL="http://127.0.0.1:${port}" PRVIEW_INSTALL_DIR="${WORK}/dest-redirect"
	else
		skip_case "latest resolved through an HTTP 302 redirect" "local http server did not start"
	fi
	kill "${SERVER_PID}" 2>/dev/null || true
	wait "${SERVER_PID}" 2>/dev/null || true
	SERVER_PID=""
else
	skip_case "latest resolved through an HTTP 302 redirect" "python3 not available"
fi

# --- 15. static audit: nothing builds from source -----------------------------
# `cargo`/`rustup`/`git clone` may appear only inside comments or message
# strings, never in command position.
if grep -nE '(^|[;&|(]|\$\()[[:space:]]*(cargo|rustup|rustc)[[:space:]]' "${INSTALL_SH}" >"${WORK}/cargo-audit.txt"; then
	FAIL=$((FAIL + 1))
	printf 'FAIL  static audit: cargo/rustup/rustc appears in command position\n'
	sed 's/^/      | /' "${WORK}/cargo-audit.txt"
else
	PASS=$((PASS + 1))
	printf 'PASS  static audit: cargo/rustup/rustc never in command position\n'
fi

if grep -nE 'git[[:space:]]+clone' "${INSTALL_SH}" >/dev/null; then
	FAIL=$((FAIL + 1))
	printf 'FAIL  static audit: install.sh mentions git clone\n'
else
	PASS=$((PASS + 1))
	printf 'PASS  static audit: install.sh never clones\n'
fi

cargo_mentions=$(grep -c 'cargo install' "${INSTALL_SH}" || true)
printf 'INFO  "cargo install" occurrences in install.sh: %s (error/help text only)\n' "${cargo_mentions}"

printf '\n%s passed, %s failed, %s skipped\n' "${PASS}" "${FAIL}" "${SKIP}"
[ "${FAIL}" = "0" ] || exit 1
exit 0
