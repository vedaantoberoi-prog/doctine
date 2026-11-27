# llama.cpp built natively on ARM64 (NEON is used automatically on Ampere A1), for benchmarking only.
# LLAMA_CPP_REF must be a release tag you have looked at (https://github.com/ggml-org/llama.cpp/releases); there is
# deliberately no default, so nothing unreviewed is built.
FROM debian:bookworm-slim AS build
ARG LLAMA_CPP_REF
RUN test -n "$LLAMA_CPP_REF" \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates git cmake build-essential \
 && git clone --depth 1 --branch "$LLAMA_CPP_REF" https://github.com/ggml-org/llama.cpp /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON -DLLAMA_CURL=OFF \
 && cmake --build /src/build -j2 --target llama-bench llama-cli

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 doctine && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin doctine
COPY --from=build /src/build/bin/ /opt/llama/
USER 10001:10001
# Example: docker compose --profile bench run --rm llm-bench /opt/llama/llama-bench -m /models/<file>.gguf -t 2 -o md
ENTRYPOINT []
