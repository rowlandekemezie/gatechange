CREATE TABLE "oauthClient" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL UNIQUE,
  "clientSecret" TEXT,
  "clientDiscoveryId" TEXT,
  "disabled" INTEGER,
  "skipConsent" INTEGER,
  "enableEndSession" INTEGER,
  "subjectType" TEXT,
  "scopes" TEXT,
  "clientCredentialsScopes" TEXT,
  "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "createdAt" DATE,
  "updatedAt" DATE,
  "name" TEXT,
  "uri" TEXT,
  "icon" TEXT,
  "contacts" TEXT,
  "tos" TEXT,
  "policy" TEXT,
  "softwareId" TEXT,
  "softwareVersion" TEXT,
  "softwareStatement" TEXT,
  "redirectUris" TEXT NOT NULL,
  "postLogoutRedirectUris" TEXT,
  "backchannelLogoutUri" TEXT,
  "backchannelLogoutSessionRequired" INTEGER,
  "tokenEndpointAuthMethod" TEXT,
  "applicationType" TEXT,
  "jwks" TEXT,
  "jwksUri" TEXT,
  "grantTypes" TEXT,
  "responseTypes" TEXT,
  "requirePKCE" INTEGER,
  "dpopBoundAccessTokens" INTEGER,
  "referenceId" TEXT,
  "metadata" TEXT
);

CREATE TABLE "oauthResource" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "identifier" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL,
  "accessTokenTtl" INTEGER,
  "refreshTokenTtl" INTEGER,
  "signingAlgorithm" TEXT,
  "signingKeyId" TEXT,
  "allowedScopes" TEXT,
  "customClaims" TEXT,
  "dpopBoundAccessTokensRequired" INTEGER,
  "disabled" INTEGER,
  "createdAt" DATE,
  "updatedAt" DATE,
  "policyVersion" INTEGER,
  "metadata" TEXT
);

CREATE TABLE "oauthClientResource" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "resourceId" TEXT NOT NULL REFERENCES "oauthResource" ("identifier") ON DELETE CASCADE,
  "metadata" TEXT,
  "createdAt" DATE
);

CREATE TABLE "oauthRefreshToken" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" TEXT REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "revoked" DATE,
  "rotatedAt" DATE,
  "rotationReplayResponse" TEXT,
  "rotationReplayExpiresAt" DATE,
  "authTime" DATE,
  "confirmation" TEXT,
  "scopes" TEXT NOT NULL
);

CREATE TABLE "oauthAccessToken" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "sessionId" TEXT REFERENCES "session" ("id") ON DELETE SET NULL,
  "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" TEXT,
  "authorizationCodeId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "refreshId" TEXT REFERENCES "oauthRefreshToken" ("id") ON DELETE CASCADE,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "revoked" DATE,
  "confirmation" TEXT,
  "scopes" TEXT NOT NULL
);

CREATE TABLE "oauthConsent" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "clientId" TEXT NOT NULL REFERENCES "oauthClient" ("clientId") ON DELETE CASCADE,
  "userId" TEXT REFERENCES "user" ("id") ON DELETE CASCADE,
  "referenceId" TEXT,
  "resources" TEXT,
  "requestedUserInfoClaims" TEXT,
  "scopes" TEXT NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "oauthClientAssertion" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "expiresAt" DATE NOT NULL
);

CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" ("userId");

CREATE INDEX "oauthClientResource_clientId_idx" ON "oauthClientResource" ("clientId");

CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauthClientResource" ("resourceId");

CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON "oauthClientResource" ("clientId", "resourceId");

CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" ("clientId");

CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" ("sessionId");

CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" ("userId");

CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken" ("authorizationCodeId");

CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");

CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" ("sessionId");

CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");

CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken" ("authorizationCodeId");

CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId");

CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");

CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" ("userId");
