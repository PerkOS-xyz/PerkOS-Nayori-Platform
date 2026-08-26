ALTER TABLE merchants
  ADD CONSTRAINT merchants_route_config_v1
  CHECK (
    route_config = '{}'::jsonb
    OR (
      jsonb_typeof(route_config -> 'version') = 'number'
      AND route_config ->> 'version' = '1'
      AND jsonb_typeof(route_config -> 'routes') = 'object'
      AND route_config -> 'routes' <> '{}'::jsonb
    )
  ) NOT VALID;

ALTER TABLE merchants VALIDATE CONSTRAINT merchants_route_config_v1;

CREATE INDEX merchants_active_api_key_idx
  ON merchants (api_key_hash)
  WHERE status = 'active';

ALTER TABLE quotes
  ADD CONSTRAINT quotes_max_lifetime
  CHECK (expires_at <= issued_at + interval '5 minutes') NOT VALID;

ALTER TABLE quotes VALIDATE CONSTRAINT quotes_max_lifetime;
