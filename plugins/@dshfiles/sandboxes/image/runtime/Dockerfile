# The sandbox image of remote mode A: a whole DSH runtime runs inside each sandbox, reached by the user's DSH through
# multi-host. Built from a context staged by stage.mjs (built dshfiles packages, no sources of the repository).
FROM node:24.11.1-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git bash ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY opt/dshfiles /opt/dshfiles
# Behind a TLS-intercepting proxy, pass its CA as the build secret extra_ca (docker build --secret
# id=extra_ca,src=<file>); it is used by npm during this step only and never stored in the image.
RUN --mount=type=secret,id=extra_ca set -e; \
    if [ -f /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca; fi; \
    npm install -g --no-fund --no-audit @deepseek-ai/dsh@0.2.2-rc.2; \
    cd /opt/dshfiles && npm install --omit=dev --no-fund --no-audit
# The dshfiles bundles resolve the DSH core from the runtime's own copy, so Cordis services stay one instance: every
# package the core installed, and the core itself (multi-host reads its version from it).
RUN set -e; core="$(npm root -g)/@deepseek-ai/dsh"; mkdir -p /opt/dshfiles/node_modules/@deepseek-ai; \
    for package in "$core"/node_modules/@deepseek-ai/*; do ln -sfn "$package" "/opt/dshfiles/node_modules/@deepseek-ai/$(basename "$package")"; done; \
    ln -sfn "$core" /opt/dshfiles/node_modules/@deepseek-ai/dsh

# The profile every sandbox starts from: the stock web profile plus multi-host. It is copied into the sandbox's
# DSH home at its first start, since DSH writes into its profile folder.
RUN set -e; \
    DSH_HOME=/opt/dsh-template dsh sandbox --from-default-profile web --dump-config > /dev/null; \
    cd /opt/dsh-template/profiles/sandbox; \
    node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json"));p.dependencies["@dshfiles/multi-host"]="link:/opt/dshfiles/packages/multi-host";p.dsh.profile.bundles.push("@dshfiles/multi-host");fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'; \
    mkdir -p node_modules/@dshfiles; \
    ln -s /opt/dshfiles/packages/multi-host node_modules/@dshfiles/multi-host; \
    chmod -R a+rX /opt/dsh-template

COPY start-runtime.sh /usr/local/bin/dshfiles-sandbox-runtime
RUN chmod 755 /usr/local/bin/dshfiles-sandbox-runtime
USER 1000:1000
