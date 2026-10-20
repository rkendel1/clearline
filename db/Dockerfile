# PostgreSQL 16 (Alpine, same base as before so existing volumes stay compatible) plus the pgvector extension,
# used only by the assistant's retrieval index. Business data never touches the extension.
ARG POSTGRES_BASE=postgres:16-alpine
FROM ${POSTGRES_BASE}
ARG PGVECTOR_VERSION=v0.8.0
RUN apk add --no-cache --virtual .build git build-base \
 && git clone --branch ${PGVECTOR_VERSION} --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no && make -C /tmp/pgvector install with_llvm=no \
 && rm -rf /tmp/pgvector && apk del .build
