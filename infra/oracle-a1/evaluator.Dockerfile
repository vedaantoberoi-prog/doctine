# Doctine medical evaluation runner, ARM64. Only the evaluation files are copied: no app code, no secrets.
# The official Node image is published for linux/arm64. For a reproducible build, pin it to a digest:
#   docker buildx imagetools inspect node:22-bookworm-slim   →  use node:22-bookworm-slim@sha256:<digest>
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
COPY tests/live-eval.mjs tests/medical-eval-cases.mjs tests/medical-eval-grader.mjs tests/safety-cases.mjs ./tests/
RUN groupadd -g 10001 doctine && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin doctine \
 && node --check tests/live-eval.mjs
USER 10001:10001
ENTRYPOINT ["node", "tests/live-eval.mjs"]
