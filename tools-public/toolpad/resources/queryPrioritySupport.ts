import { createFunction } from '@mui/toolpad/server';

const { sheets } = require('@googleapis/sheets');
const { JWT } = require('google-auth-library');
const { Octokit } = require("@octokit/core");

function findRowByValue(sheet, value) {
  for (let i = 0; i < sheet.length; i++) {
    if (sheet[i][0] === value) {
      return i;
    }
  }
  return -1;
}

async function updateGitHubIssueLabels(issueId) {
  if (!process.env.GITHUB_TOKEN) {
    throw new Error('Env variable GITHUB_TOKEN not configured');
  }

  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
  });

  const octokitRequestMetadata = {
    owner: 'mui',
    repo: 'mui-x',
    issue_number: issueId,
    headers: {
      'X-GitHub-Api-Version': '2022-11-28'
    }
  };

  await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
    ...octokitRequestMetadata,
    name: 'priority support: unverified',
  });

  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
    ...octokitRequestMetadata,
    labels: [
      'priority support: verified'
    ],
  });
}

export const queryPrioritySupport = createFunction(
  async function queryPrioritySupport({ parameters }) {
    if (!process.env.GOOGLE_SHEET_TOKEN) {
      throw new Error('Env variable GOOGLE_SHEET_TOKEN not configured');
    }

    if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
      throw new Error('Env variable GOOGLE_SERVICE_ACCOUNT not configured');
    }

    if (parameters.issueId === '') {
      return  {
        status: 'missing issue id',
      };
    }

    if (parameters.supportKey === '') {
      return  {
        status: 'missing support key',
      };;
    }

    const googleAuth = new JWT({
      email: process.env.GOOGLE_SERVICE_ACCOUNT,
      key: process.env.GOOGLE_SHEET_TOKEN.replace(/\\n/g, '\n'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const service = sheets({ version: 'v4', auth: googleAuth });
    const spreadsheetId = '1RNYabJOzAs4pzMN6WI0yAfeGXOqDiMU1t8TpqA1EPjE';

    const res = await service.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet1!A2:B50',
    });

    const rows = res.data.values;
    const row = findRowByValue(rows, parameters.supportKey);
    const today = new Date();

    if (row === -1) {
      return  {
        status: 'no support key found',
      };
    }

    const targetSupportKeyExpirationDate = new Date(rows[row][1]);

    if (targetSupportKeyExpirationDate < today) {
      return  {
        status: 'support key expired',
      };
    }

    await updateGitHubIssueLabels(parameters.issueId);

    return {
      status: 'success',
    };
  },
  {
    parameters: {
      issueId: {
        typeDef: { type: "string" },
      },
      supportKey: {
        typeDef: { type: "string" },
      },
    },
  }
);