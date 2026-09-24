# Test image: Node 22 + Java 21 + Firestore emulator.
# Runs everything against a local emulator (demo- project id); never touches a real Firebase project.
#
#   docker build -t auction-vue-test .
#   docker run --rm auction-vue-test                      # rules tests (default)
#   docker run --rm auction-vue-test npm test             # unit tests
#   docker run --rm auction-vue-test npm run lint
FROM node:22-bookworm-slim

COPY --from=eclipse-temurin:21-jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk \
    PATH=/opt/java/openjdk/bin:$PATH \
    CI=true \
    NO_UPDATE_NOTIFIER=1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Bake the emulator JAR into the image so test runs need no downloads.
RUN npx firebase setup:emulators:firestore

COPY . .

CMD ["npm", "run", "test:rules"]
