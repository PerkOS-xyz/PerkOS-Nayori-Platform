CREATE TABLE partner_invitations (
  invitation_id varchar(35) PRIMARY KEY,
  merchant_id varchar(64) NOT NULL REFERENCES merchants(merchant_id),
  token_digest char(64) NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(scopes) > 0)
);

CREATE TABLE wallet_auth_challenges (
  challenge_id varchar(35) PRIMARY KEY,
  invitation_id varchar(35) NOT NULL REFERENCES partner_invitations(invitation_id),
  merchant_id varchar(64) NOT NULL REFERENCES merchants(merchant_id),
  wallet_address varchar(64) NOT NULL,
  network varchar(16) NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_clients (
  client_id varchar(35) PRIMARY KEY,
  merchant_id varchar(64) NOT NULL REFERENCES merchants(merchant_id),
  wallet_address varchar(64) NOT NULL,
  secret_digest char(64) NOT NULL,
  scopes text[] NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_token_at timestamptz,
  CHECK (cardinality(scopes) > 0)
);

CREATE INDEX wallet_auth_challenges_expiry_idx
  ON wallet_auth_challenges (expires_at)
  WHERE used_at IS NULL;

CREATE INDEX oauth_clients_merchant_idx ON oauth_clients (merchant_id, status);
