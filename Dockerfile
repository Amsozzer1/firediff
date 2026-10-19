# syntax=docker/dockerfile:1.7
# The hosted playground (`firediff playground --hosted`): the committed dist/cli bundle on Node 22,
# Java 21 for the emulator, and the emulator jar baked in. deploy/README.md has the steps.
FROM eclipse-temurin:21-jre-noble AS java

FROM node:22-bookworm-slim
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk \
    FIREDIFF_EMULATOR_JAR=/opt/firediff/cloud-firestore-emulator-v1.22.0.jar
# Same jar and checksum as EMULATOR_JAR in src/run/emulator.ts.
ADD --checksum=sha256:9b6498b7f62714d67f48f59b3818883cd682dbcd46b9f59511de81c97bb5166c \
    https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.22.0.jar \
    /opt/firediff/cloud-firestore-emulator-v1.22.0.jar
RUN chmod 644 /opt/firediff/cloud-firestore-emulator-v1.22.0.jar
COPY dist/cli /opt/firediff/cli

USER node
WORKDIR /home/node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/opt/firediff/cli/index.js"]
CMD ["playground", "--hosted", "--host", "0.0.0.0", "--port", "8787"]
