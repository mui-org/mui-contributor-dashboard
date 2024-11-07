// @ts-check
const vBranchRegex = /^v\d{1,3}\.x$/;
const targetBranches = [];

/**
 * @param {Object} params
 * @param {import("@actions/core")} params.core
 * @param {ReturnType<import("@actions/github").getOctokit>} params.github
 * @param {import("@actions/github").context} params.context
 */
module.exports = async ({ core, context, github }) => {
  try {
    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const pullNumber = context.issue.number;

    const { data: pr } = await github.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    core.info(`>>> PR fetched: ${pr.number}`);

    const prLabels = pr.labels.map((label) => label.name);

    // filter the target labels from the original PR
    const targetLabels = prLabels.filter((label) => vBranchRegex.test(label));
    const otherLabels = prLabels.filter(
      (label) => label !== 'needs cherry-pick' && !vBranchRegex.test(label),
    );

    if (targetLabels.length === 0) {
      // there was no target branch present
      core.info('>>> No target label found');

      if (vBranchRegex.test(pr.head_ref)) {
        // the branch this is coming from is a version branch, so the cherry-pick target should be master
        core.info('>>> Head Ref is a version branch, setting `master` as target');
        core.setOutput('TARGET_BRANCHES', ['master']);
        return;
      }

      // the PR is not coming from a version branch
      core.setOutput('TARGET_BRANCHES', '');
      return;
    }

    core.info(`>>> Target labels found: ${targetLabels.join(', ')}`);

    // get a list of the original reviewers
    const reviewers = pr.requested_reviewers.map((reviewer) => reviewer.login);
    core.info(`>>> Reviewers from original PR: ${reviewers.join(', ')}`);

    core.info(`>>> Creating explanatory comment on PR`);
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body: `Cherry-pick PRs will be created targeting branches: ${targetLabels.join(', ')}`,
    });

    // set the target branches as output to be used as an input for the next step
    core.setOutput('TARGET_BRANCHES', targetLabels);
    core.setOutput('LABELS', ['cherry-pick', ...otherLabels].join(','));
    core.setOutput('REVIEWERS', reviewers.join(','));
  } catch (error) {
    core.error(`>>> Workflow failed with: ${error.message}`);
    core.setFailed(error.message);
  }
};
