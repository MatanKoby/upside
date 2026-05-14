# IB Client Portal Gateway — Java app from IB that exposes the REST API on :5000.
# This is DIFFERENT from the legacy TWS Socket API (Java client ports 4001-4004);
# our backend code in server/src/services/ibGateway.ts targets `/v1/api/iserver/*`
# which is served by this gateway, not the TWS one.
#
# Login flow: start container, point a browser at https://localhost:5000, log in
# with live IB credentials + 2FA. Credentials NEVER pass through this Dockerfile
# or any env var — they go from browser → gateway → IB servers only.

# Pin a major JRE version. Temurin 17 LTS is the safe default for clientportal.gw.
FROM eclipse-temurin:17-jre-jammy AS base

ARG CPG_URL=https://download2.interactivebrokers.com/portal/clientportal.gw.zip

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/clientportal.gw

# Fetch IB's official zip at build time. Verified at https://download2.interactivebrokers.com/portal/clientportal.gw.zip
RUN curl -fSL "$CPG_URL" -o /tmp/cpg.zip \
 && unzip /tmp/cpg.zip \
 && rm /tmp/cpg.zip

EXPOSE 5000

# `bin/run.sh` is IB's launcher. `root/conf.yaml` is the default config that
# binds the gateway to 0.0.0.0:5000 inside the container.
ENTRYPOINT ["bin/run.sh", "root/conf.yaml"]
