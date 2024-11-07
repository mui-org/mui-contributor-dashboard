import { request } from 'graphql-request';
import mysql from 'mysql2/promise';
import SSH2Promise from 'ssh2-promise';

export async function getRepositoryDetails(slug: string) {
  const res = await fetch(`https://api.ossinsight.io/gh/repo/${slug}`, {
    method: 'GET',
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return res.json();
}

export async function PRsOpenandReviewedQuery() {
  const openQuery = `
with pr_opened as (
  SELECT
    number,
    date_format(created_at, '%Y-%m-01') AS event_month,
    actor_login
  FROM
    github_events ge
  WHERE
    type = 'PullRequestEvent'
    AND action = 'opened'
    AND repo_id = 23083156
    AND ge.created_at >= '2021-12-01'
    AND actor_login NOT LIKE '%bot'
    AND actor_login NOT LIKE '%[bot]'
    AND ge.actor_login NOT LIKE 'mnajdova'
    AND ge.actor_login NOT LIKE 'michaldudak'
    AND ge.actor_login NOT LIKE 'siriwatknp'
    AND ge.actor_login NOT LIKE 'oliviertassinari'
    AND ge.actor_login NOT LIKE 'mj12albert'
    AND ge.actor_login NOT LIKE 'DiegoAndai'
    AND ge.actor_login NOT LIKE 'brijeshb42'
), pr_reviewed as (
  SELECT
    number,
    date_format(created_at, '%Y-%m-01') AS event_month,
    actor_login
  FROM
      github_events ge
  WHERE
      ge.repo_id = 23083156
  AND ge.type = 'PullRequestReviewEvent'
  AND ge.action = 'created'
  AND ge.created_at >= '2021-12-01'
  AND ge.actor_login NOT LIKE '%bot'
  AND ge.actor_login NOT LIKE '%[bot]'
  AND ge.actor_login IN ('mnajdova','michaldudak','siriwatknp','oliviertassinari','mj12albert', 'DiegoAndai', 'brijeshb42')
), pr_reviewed_with_open_by as (
  SELECT
    pr_reviewed.event_month,
    pr_reviewed.number,
    pr_reviewed.actor_login as reviewed_by,
    pr_opened.actor_login as open_by
  FROM pr_reviewed
  JOIN pr_opened on pr_opened.number = pr_reviewed.number)
, pr_open_by_core as (
  SELECT
    number,
    date_format(created_at, '%Y-%m-01') AS event_month,
    actor_login
  FROM
    github_events ge
  WHERE
    type = 'PullRequestEvent'
    AND action = 'opened'
    AND repo_id = 23083156
    AND ge.created_at >= '2021-12-01'
    -- AND ge.created_at < '2023-01-01'
    AND actor_login NOT LIKE '%bot'
    AND actor_login NOT LIKE '%[bot]'
    AND ge.actor_login IN
    ('mnajdova','michaldudak','siriwatknp','oliviertassinari','mj12albert', 'DiegoAndai', 'brijeshb42')
), final_table AS (
  SELECT
    n.event_month,
    n.reviewed_by,
    COUNT(DISTINCT n.number) as reviewed,
    COUNT(DISTINCT p.number) as opened
  FROM pr_reviewed_with_open_by n
  JOIN
    pr_open_by_core p ON p.actor_login = n.reviewed_by AND p.event_month = n.event_month
  GROUP BY
    event_month,
    reviewed_by
  ORDER BY
    event_month DESC
)

SELECT * FROM final_table
  `;
  const res = await fetch('https://api.ossinsight.io/q/playground', {
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sql: openQuery, type: 'repo', id: '23083156' }),
    method: 'POST',
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  return data.data;
}

export async function getTeamIssues(repo: string = 'mui/material-ui') {
  if (repo === '') {
    return [];
  }

  const repoMap = {
    'mui/material-ui': 23083156,
    'mui/base-ui': 762289766,
    'mui/pigment-css': 715829513,
    'vercel/next.js': 70107786,
    'radix-ui/primitives': 273499522,
  };

  const repoParam = repoMap[repo] ?? repo;

  const openQuery = `
WITH maintainers as (
  SELECT
    DISTINCT ge.actor_login
  FROM
    github_events ge
  WHERE
    ge.repo_id = ${repoParam}
    AND ge.type = 'PullRequestEvent'
    /* maintainers are defined as the ones that are allowed to merge PRs */
    AND ge.action = 'closed'
    AND ge.pr_merged = 1
    AND ge.created_at >= '2016-01-01'
),
issues AS (
  SELECT
      DATE_FORMAT(created_at, '%Y-%m-01') AS event_month,
      COUNT(*) AS cnt
  FROM github_events ge
  WHERE 
  type = 'IssuesEvent' 
  AND action = 'opened' 
  AND ge.repo_id = ${repoParam}
  AND ge.actor_login in (SELECT actor_login FROM maintainers)
  AND event_month >= '2020-01-01'
  GROUP BY 1
  ORDER BY 1
), issue_comments AS (
  SELECT
      DATE_FORMAT(created_at, '%Y-%m-01') AS event_month,
      COUNT(*) AS cnt
  FROM github_events ge
  WHERE 
  type = 'IssueCommentEvent' 
  AND action = 'created'
  AND ge.repo_id = ${repoParam}
  AND ge.actor_login in (SELECT actor_login FROM maintainers)
  AND event_month >= '2020-01-01'
  GROUP BY 1
  ORDER BY 1
), event_months AS (
  SELECT DISTINCT event_month
  FROM (
      SELECT event_month
      FROM issues
      UNION
      SELECT event_month
      FROM issue_comments
  ) sub
)
SELECT
  m.event_month,
  IFNULL(i.cnt, 0) + IFNULL(ic.cnt, 0) AS issues_activity
FROM event_months m
LEFT JOIN issues i ON m.event_month = i.event_month
LEFT JOIN issue_comments ic ON m.event_month = ic.event_month
ORDER BY m.event_month ASC
  `;
  const res = await fetch('https://api.ossinsight.io/q/playground', {
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sql: openQuery, type: 'repo', id: `${repoParam}` }),
    method: 'POST',
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  return data.data;
}

export async function queryCommitStatuses(repository: string) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error(`Env variable GITHUB_TOKEN not configured`);
  }

  const since = new Date();
  since.setDate(since.getDate() - 7);

  const endpoint = 'https://api.github.com/graphql';
  const token = process.env.GITHUB_TOKEN;

  const query = `
query getCommitStatuses($repository: String!, $since: GitTimestamp!) {
  repository(owner: "mui", name: $repository) {
    defaultBranchRef {
      id
      name
      target {
        ... on Commit {
          history(since: $since) {
            nodes {
              messageHeadline
              committedDate
              status {
                state
              }
            }
          }
        }
      }
    }
  }
}
`;

  const response = request(
    endpoint,
    query,
    {
      repository,
      since: since.toISOString(),
    },
    {
      Authorization: `Bearer ${token}`,
    },
  );

  return response;
}

export async function getRatio() {
  if (!process.env.STORE_PRODUCTION_READ_PASSWORD) {
    throw new Error(`Env variable STORE_PRODUCTION_READ_PASSWORD not configured`);
  }
  if (!process.env.BASTION_SSH_KEY) {
    throw new Error(`Env variable BASTION_SSH_KEY not configured`);
  }

  const ssh = new SSH2Promise({
    host: process.env.BASTION_HOST,
    port: 22,
    username: process.env.BASTION_USERNAME,
    privateKey: process.env.BASTION_SSH_KEY.replace(/\\n/g, '\n'),
  });

  const tunnel = await ssh.addTunnel({
    remoteAddr: process.env.STORE_PRODUCTION_READ_HOST,
    remotePort: 3306,
  });

  const connection = await mysql.createConnection({
    host: 'localhost',
    port: tunnel.localPort,
    user: process.env.STORE_PRODUCTION_READ_USERNAME,
    password: process.env.STORE_PRODUCTION_READ_PASSWORD,
    database: process.env.STORE_PRODUCTION_READ_DATABASE,
  });

  const [ratio] = await connection.execute(`
SELECT
overdue.total / order_30.total AS ratio
-- overdue.total,
-- order_30.total
FROM
(
  SELECT
    sum(post.total) AS total
  FROM
    (
      SELECT
        postmeta1.meta_value - postmeta2.meta_value AS total,
        CASE
          WHEN postmeta3.meta_value IS NOT NULL THEN postmeta3.meta_value
          ELSE 30
        END AS payment_term,
        from_unixtime(
          postmeta4.meta_value + (
            CASE
              WHEN postmeta3.meta_value IS NOT NULL THEN postmeta3.meta_value
              ELSE 30
            END
          ) * 3600 * 24
        ) AS invoice_due,
        postmeta4.meta_value AS invoice_date,
        postmeta5.meta_value AS billing_country,
        post.id
      FROM
        wp3u_posts post
        LEFT JOIN wp3u_postmeta postmeta1 ON postmeta1.post_id = post.id
        AND postmeta1.meta_key = '_order_total'
        LEFT JOIN wp3u_postmeta postmeta2 ON postmeta2.post_id = post.id
        AND postmeta2.meta_key = '_order_tax'
        LEFT JOIN wp3u_postmeta postmeta3 ON postmeta3.post_id = post.id
        AND postmeta3.meta_key = 'payment_term'
        LEFT JOIN wp3u_postmeta postmeta4 ON postmeta4.post_id = post.id
        AND postmeta4.meta_key = '_wcpdf_invoice_date'
        LEFT JOIN wp3u_postmeta postmeta5 ON postmeta5.post_id = post.id
        AND postmeta5.meta_key = '_billing_country'
      WHERE
        post.post_status = 'wc-processing'
        AND post.post_type = 'shop_order'
        AND post.post_parent = '0' -- ignore orders that are sub-orders
      order by
        post.post_date desc
    ) AS post
  WHERE
    DATEDIFF(now(), post.invoice_due) > 0
) AS overdue,
(
  SELECT
    sum(postmeta1.meta_value - postmeta2.meta_value) AS total
  FROM
    wp3u_posts post
    LEFT JOIN wp3u_postmeta postmeta1 ON postmeta1.post_id = post.id
    AND postmeta1.meta_key = '_order_total'
    LEFT JOIN wp3u_postmeta postmeta2 ON postmeta2.post_id = post.id
    AND postmeta2.meta_key = '_order_tax'
  WHERE
    post.post_status = 'wc-completed'
    AND post.post_type = 'shop_order'
    AND post.post_date >= date_sub(now(), interval 30 day)
    AND post.post_parent = '0' -- ignore orders that are sub-orders
) AS order_30
  `);

  await connection.end();
  await ssh.close();

  return ratio[0];
}

export async function PRsPerMonth(repositoryId: string, startDate: string) {
  if (!repositoryId) {
    return [];
  }

  startDate = startDate || '2016-01-01';

  const openQuery = `
with maintainers as (
  SELECT
    DISTINCT ge.actor_login
  FROM
    github_events ge
  WHERE
    ge.repo_id = ${repositoryId}
    AND ge.type = 'PullRequestEvent'
    /* maintainers are defined as the ones that are allowed to merge PRs */
    AND ge.action = 'closed'
    AND ge.pr_merged = 1
    AND ge.created_at >= '2016-01-01'
), pr_merged AS (
  SELECT
    number,
    date_format(created_at, '%Y-%m-01') AS event_month,
    actor_login
  FROM
    github_events ge
  WHERE
    type = 'PullRequestEvent'
    AND action = 'closed'
    AND ge.pr_merged = 1
    AND repo_id = ${repositoryId}
    AND ge.created_at >= '${startDate}'
), pr_opened as (
  SELECT
    number,
    date_format(created_at, '%Y-%m-01') AS event_month,
    actor_login
  FROM
    github_events ge
  WHERE
    type = 'PullRequestEvent'
    AND action = 'opened'
    AND repo_id = ${repositoryId}
    AND ge.created_at >= '2016-01-01'
    AND actor_login NOT LIKE '%bot'
    AND actor_login NOT LIKE '%[bot]'
), pr_merged_with_open_by as (
  SELECT
    pr_merged.event_month,
    pr_merged.number,
    pr_opened.actor_login as open_by,
    pr_merged.actor_login as merged_by
  FROM
    pr_merged
    JOIN pr_opened on pr_opened.number = pr_merged.number
), pr_stats as (
  SELECT
    pr_community.event_month,
    COUNT(DISTINCT pr_community.number) AS pr_community_count,
    COUNT(DISTINCT pr_maintainers.number) AS pr_maintainers_count
  FROM pr_merged_with_open_by as pr_community
  LEFT JOIN pr_merged_with_open_by  as pr_maintainers
    ON pr_community.event_month = pr_maintainers.event_month
  WHERE
        pr_community.open_by NOT IN (SELECT actor_login FROM maintainers)
    AND pr_maintainers.open_by IN (SELECT actor_login FROM maintainers)
  GROUP BY
    pr_community.event_month
  ORDER BY
    pr_community.event_month asc
)

SELECT * FROM pr_stats ge;
    `;

  const res = await fetch('https://api.ossinsight.io/q/playground', {
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sql: openQuery,
      type: 'repo',
      id: repositoryId,
    }),
    method: 'POST',
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  return data.data.map((x) => ({ x: x.month, y: x.prs, ...x }));
}

export async function ContributorsPerMonth(repositoryId: string, startDate: string) {
  if (!repositoryId) {
    return [];
  }

  startDate = startDate || '2016-01-01';

  const openQuery = `
with maintainers as (
  SELECT
    DISTINCT ge.actor_login
  FROM
    github_events ge
  WHERE
    ge.repo_id = ${repositoryId}
    AND ge.type = 'PullRequestEvent'
    /* maintainers are defined as the ones that are allowed to merge PRs */
    AND ge.action = 'closed'
    AND ge.pr_merged = 1
    AND ge.created_at >= '2016-01-01'
), pr_merged AS (
  SELECT
    number,
    date_format(created_at, '%Y-%m-01') AS event_month,
    actor_login
  FROM
    github_events ge
  WHERE
    type = 'PullRequestEvent'
    AND action = 'closed'
    AND ge.pr_merged = 1
    AND repo_id = ${repositoryId}
    AND ge.created_at >= '${startDate}'
), pr_opened as (
  SELECT
    number,
    date_format(created_at, '%Y-%m-01') AS event_month,
    actor_login
  FROM
    github_events ge
  WHERE
    type = 'PullRequestEvent'
    AND action = 'opened'
    AND repo_id = ${repositoryId}
    AND ge.created_at >= '2016-01-01'
    AND actor_login NOT LIKE '%bot'
    AND actor_login NOT LIKE '%[bot]'
), pr_merged_with_open_by as (
  SELECT
    pr_merged.event_month,
    pr_merged.number,
    pr_opened.actor_login as open_by,
    pr_merged.actor_login as merged_by
  FROM
    pr_merged
    JOIN pr_opened on pr_opened.number = pr_merged.number
), pr_stats as (
  SELECT
    pr_community.event_month,
    COUNT(DISTINCT pr_community.open_by) AS pr_community_count,
    COUNT(DISTINCT pr_maintainers.open_by) AS pr_maintainers_count
  FROM pr_merged_with_open_by as pr_community
  LEFT JOIN pr_merged_with_open_by  as pr_maintainers
    ON pr_community.event_month = pr_maintainers.event_month
  WHERE
        pr_community.open_by NOT IN (SELECT actor_login FROM maintainers)
    AND pr_maintainers.open_by IN (SELECT actor_login FROM maintainers)
  GROUP BY
    pr_community.event_month
  ORDER BY
    pr_community.event_month asc
)

SELECT * FROM pr_stats ge;
    `;

  const res = await fetch('https://api.ossinsight.io/q/playground', {
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sql: openQuery,
      type: 'repo',
      id: repositoryId,
    }),
    method: 'POST',
  });
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const data = await res.json();
  return data.data.map((x) => ({ x: x.month, y: x.prs, ...x }));
}
