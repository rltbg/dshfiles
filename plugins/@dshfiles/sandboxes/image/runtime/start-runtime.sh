#!/bin/sh
# Start the DSH runtime of a remote-mode sandbox. DSH_HOME is the sandbox's own home, on its workspace volume.
set -eu
: "${DSH_HOME:?DSH_HOME must name the sandbox's DSH home}"
if [ ! -d "$DSH_HOME/profiles/sandbox" ]; then
  mkdir -p "$DSH_HOME/profiles"
  cp -a /opt/dsh-template/profiles/sandbox "$DSH_HOME/profiles/"
fi
# Native bindings are copied to a cache and loaded from there; /tmp is noexec in a hardened sandbox.
export NARB_NATIVE_CACHE_DIR="$DSH_HOME/.native-cache"
exec dsh sandbox --host 127.0.0.1 --port 0 --no-open
