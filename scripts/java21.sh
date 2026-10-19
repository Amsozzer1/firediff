#!/usr/bin/env bash
# Run a command with JAVA_HOME pointing at a Java 21 JDK (the Firestore emulator needs it).
set -euo pipefail

is_java21() {
  [ -x "$1/bin/java" ] && grep -q '^JAVA_VERSION="21[."]' "$1/release" 2>/dev/null
}

java_home=""
# An explicit JAVA_HOME wins when it really is 21 (e.g. actions/setup-java on CI).
if [ -n "${JAVA_HOME:-}" ] && is_java21 "$JAVA_HOME"; then
  java_home="$JAVA_HOME"
# java_home -v 21 falls back to the default JVM (exit 0) when no 21 is registered, so check the result.
elif [ -x /usr/libexec/java_home ] && candidate="$(/usr/libexec/java_home -v 21 2>/dev/null)" && is_java21 "$candidate"; then
  java_home="$candidate"
elif is_java21 /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home; then
  java_home="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
elif is_java21 /opt/homebrew/opt/openjdk@21; then
  java_home="/opt/homebrew/opt/openjdk@21"
fi

if [ -z "$java_home" ]; then
  echo "firediff: Java 21 not found." >&2
  echo "  Tried: /usr/libexec/java_home -v 21, /opt/homebrew/opt/openjdk@21" >&2
  echo "  Install it with: brew install openjdk@21" >&2
  exit 2
fi

export JAVA_HOME="$java_home"
export PATH="$JAVA_HOME/bin:$PATH"
exec "$@"
