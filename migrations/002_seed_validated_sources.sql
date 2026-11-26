-- Validated against each provider's public JSON endpoint on 2026-11-26.
-- The source upserts preserve any operator-managed URLs and active state.
ALTER TABLE ingestion_runs
  ADD COLUMN IF NOT EXISTS jobs_unchanged INTEGER NOT NULL DEFAULT 0;

INSERT INTO companies (name, website_url, careers_url) VALUES
  ('Stripe', 'https://stripe.com', 'https://stripe.com/jobs'),
  ('Figma', 'https://www.figma.com', 'https://www.figma.com/careers'),
  ('Anthropic', 'https://www.anthropic.com', 'https://www.anthropic.com/careers'),
  ('Datadog', 'https://www.datadoghq.com', 'https://www.datadoghq.com/careers'),
  ('Cloudflare', 'https://www.cloudflare.com', 'https://www.cloudflare.com/careers'),
  ('Asana', 'https://asana.com', 'https://asana.com/jobs'),
  ('Coinbase', 'https://www.coinbase.com', 'https://www.coinbase.com/careers'),
  ('Coderio', 'https://coderio.co', 'https://coderio.co/careers'),
  ('Reply', 'https://www.reply.com', 'https://www.reply.com/careers'),
  ('CLO Virtual Fashion', 'https://clovirtualfashion.com', 'https://clovirtualfashion.com/careers'),
  ('Gauss Labs', 'https://www.gausslabs.ai', 'https://www.gausslabs.ai/careers'),
  ('WalkMe', 'https://www.walkme.com', 'https://www.walkme.com/careers'),
  ('Trendyol', 'https://www.trendyol.com', 'https://www.trendyol.com/careers'),
  ('Linear', 'https://linear.app', 'https://linear.app/careers'),
  ('Vanta', 'https://www.vanta.com', 'https://www.vanta.com/careers'),
  ('Sentry', 'https://sentry.io', 'https://sentry.io/careers'),
  ('Mercor', 'https://www.mercor.com', 'https://www.mercor.com/careers'),
  ('Ramp', 'https://ramp.com', 'https://ramp.com/careers'),
  ('Webflow', 'https://webflow.com', 'https://webflow.com/careers'),
  ('PostHog', 'https://posthog.com', 'https://posthog.com/careers')
ON CONFLICT (name) DO UPDATE SET
  website_url = COALESCE(companies.website_url, EXCLUDED.website_url),
  careers_url = COALESCE(companies.careers_url, EXCLUDED.careers_url);

INSERT INTO ats_sources (company_id, provider, board_identifier, endpoint_url)
SELECT c.id, v.provider, v.board_identifier, v.endpoint_url
FROM (VALUES
  ('Stripe', 'greenhouse', 'stripe', 'https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true'),
  ('Figma', 'greenhouse', 'figma', 'https://boards-api.greenhouse.io/v1/boards/figma/jobs?content=true'),
  ('Anthropic', 'greenhouse', 'anthropic', 'https://boards-api.greenhouse.io/v1/boards/anthropic/jobs?content=true'),
  ('Datadog', 'greenhouse', 'datadog', 'https://boards-api.greenhouse.io/v1/boards/datadog/jobs?content=true'),
  ('Cloudflare', 'greenhouse', 'cloudflare', 'https://boards-api.greenhouse.io/v1/boards/cloudflare/jobs?content=true'),
  ('Asana', 'greenhouse', 'asana', 'https://boards-api.greenhouse.io/v1/boards/asana/jobs?content=true'),
  ('Coinbase', 'greenhouse', 'coinbase', 'https://boards-api.greenhouse.io/v1/boards/coinbase/jobs?content=true'),
  ('Coderio', 'lever', 'coderio', 'https://api.lever.co/v0/postings/coderio?mode=json'),
  ('Reply', 'lever', 'reply', 'https://api.lever.co/v0/postings/reply?mode=json'),
  ('CLO Virtual Fashion', 'lever', 'clovirtualfashion', 'https://api.lever.co/v0/postings/clovirtualfashion?mode=json'),
  ('Gauss Labs', 'lever', 'gausslabs', 'https://api.lever.co/v0/postings/gausslabs?mode=json'),
  ('WalkMe', 'lever', 'walkme', 'https://api.lever.co/v0/postings/walkme?mode=json'),
  ('Trendyol', 'lever', 'trendyol', 'https://api.lever.co/v0/postings/trendyol?mode=json'),
  ('Linear', 'ashby', 'linear', 'https://api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true'),
  ('Vanta', 'ashby', 'vanta', 'https://api.ashbyhq.com/posting-api/job-board/vanta?includeCompensation=true'),
  ('Sentry', 'ashby', 'sentry', 'https://api.ashbyhq.com/posting-api/job-board/sentry?includeCompensation=true'),
  ('Mercor', 'ashby', 'mercor', 'https://api.ashbyhq.com/posting-api/job-board/mercor?includeCompensation=true'),
  ('Ramp', 'ashby', 'ramp', 'https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true'),
  ('Webflow', 'ashby', 'webflow', 'https://api.ashbyhq.com/posting-api/job-board/webflow?includeCompensation=true'),
  ('PostHog', 'ashby', 'posthog', 'https://api.ashbyhq.com/posting-api/job-board/posthog?includeCompensation=true')
) AS v(company_name, provider, board_identifier, endpoint_url)
JOIN companies c ON c.name = v.company_name
ON CONFLICT (provider, board_identifier) DO UPDATE SET
  endpoint_url = COALESCE(ats_sources.endpoint_url, EXCLUDED.endpoint_url);
