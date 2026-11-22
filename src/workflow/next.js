/**
 * The next step of a story, worked out from what has been recorded.
 *
 * The ticket-to-pull-request workflow has a fixed order. Holding that order
 * in a model's context for a whole session is where steps get skipped or
 * repeated, so the order lives here instead: given the recorded facts, this
 * returns the one thing to do now, who does it, the command, and why.
 *
 * nextStep() is pure. The command layer gathers the facts.
 */

/**
 * @typedef {object} RepoFacts
 * @property {string} name
 * @property {boolean} prepared a feature branch has been recorded for the story
 * @property {boolean} cloneExists
 * @property {string | null} featureBranch
 * @property {string | null} currentBranch
 * @property {boolean} dirty uncommitted changes
 * @property {number} changedFiles files that differ from the release branch (committed or not)
 * @property {Array<{ gate: string, reason: string }>} worktreeBlockers gates not valid for the working tree
 * @property {Array<{ gate: string, reason: string }>} headBlockers gates not valid for the last commit
 * @property {{ url?: string | null, created?: boolean } | null} pr
 *
 * @typedef {object} StoryFacts
 * @property {string} storyId
 * @property {boolean} storyRead
 * @property {string[]} storyGaps
 * @property {string[]} projectRepositories
 * @property {boolean} planRequired
 * @property {{ exists: boolean, evaluated: boolean, stale: boolean, verdict: string | null, rounds: number, blocking: string[], shouldFix: string[] }} plan
 * @property {RepoFacts[]} repos
 * @property {boolean} [learningChecked] the learning check has been run for this story
 * @property {Array<{ id: string, action: string, summary: string }>} [pendingApprovals] requests waiting for a person
 *
 * @typedef {object} Step
 * @property {string} step
 * @property {string} title
 * @property {'auto-developer' | 'plan-reviewer' | 'code-reviewer' | 'user'} actor who acts now
 * @property {string | null} command the command to run, when there is one
 * @property {string | null} skill the skill that explains this step
 * @property {string} why
 * @property {string | null} repository
 * @property {string[]} [details]
 */

const GATE_ORDER = ['tests', 'automated-review', 'independent-review'];

/**
 * @param {StoryFacts} facts
 * @param {RepoFacts} repo
 * @param {Array<{ gate: string, reason: string }>} blockers
 * @returns {Step | null}
 */
function gateStep(facts, repo, blockers) {
  const story = facts.storyId;
  const first = GATE_ORDER.map((gate) => blockers.find((blocker) => blocker.gate === gate)).find(Boolean);
  if (!first) return null;
  if (first.gate === 'tests') {
    return {
      step: 'test', title: `Run the tests for ${repo.name}`, actor: 'auto-developer', skill: 'testing', repository: repo.name,
      command: `autodev test run --story ${story} --repo ${repo.name}`,
      why: `Tests gate: ${first.reason}`,
      details: [`Also run the end-to-end scenarios this change touches: autodev scenario affected --story ${story} --repo ${repo.name}`],
    };
  }
  if (first.gate === 'automated-review') {
    return {
      step: 'automated-review', title: `Run the automated review for ${repo.name}`, actor: 'auto-developer', skill: 'code-review', repository: repo.name,
      command: `autodev review run --story ${story} --repo ${repo.name}`,
      why: `Automated review gate: ${first.reason}`,
    };
  }
  return {
    step: 'independent-review', title: `Hand ${repo.name} to the code-reviewer agent`, actor: 'code-reviewer', skill: 'code-review', repository: repo.name,
    command: `autodev context --story ${story} --task review --repo ${repo.name}`,
    why: `Independent review gate: ${first.reason} The author cannot record this review.`,
  };
}

/**
 * @param {StoryFacts} facts
 * @returns {Step}
 */
export function nextStep(facts) {
  const story = facts.storyId;
  if (!facts.storyRead) {
    return { step: 'read-story', title: 'Read the story', actor: 'auto-developer', skill: 'agility', repository: null, command: `autodev agility story ${story}`, why: 'Nothing is recorded for this story yet. Everything else depends on its acceptance criteria and release branch.' };
  }
  const prepared = facts.repos.filter((repo) => repo.prepared);
  if (prepared.length === 0) {
    return {
      step: 'prepare-repositories', title: 'Decide which repositories are affected and prepare them', actor: 'auto-developer', skill: 'bitbucket', repository: null,
      command: `autodev repo prepare --story ${story} --repo <name>`,
      why: 'No repository has a story branch yet. Preparing one clones it and creates the feature branch from the release branch, so the plan can be written from the real code.',
      details: [`Repositories of this project: ${facts.projectRepositories.join(', ') || '(none configured)'}`, ...facts.storyGaps.map((gap) => `Ask the user first: ${gap}`)],
    };
  }

  const { plan } = facts;
  const planNote = facts.planRequired ? '' : ' (This project sets planReview to advisory: the step is expected but does not block a commit.)';
  if (!plan.exists) {
    return {
      step: 'write-plan', title: 'Write the plan and submit it', actor: 'auto-developer', skill: 'plan-review', repository: null,
      command: `autodev plan submit --story ${story} --file <plan.md>`,
      why: `No plan is recorded. Code is written only against an evaluated plan.${planNote}`,
      details: [`Get the ticket, guidelines and repository layout in one call: autodev context --story ${story} --task plan`],
    };
  }
  if (!plan.evaluated || plan.stale) {
    return {
      step: 'evaluate-plan', title: 'Hand the plan to the plan-reviewer agent', actor: 'plan-reviewer', skill: 'plan-review', repository: null,
      command: `autodev plan check --story ${story}`,
      why: `${plan.stale ? 'The plan changed after it was evaluated.' : 'The plan has not been evaluated.'} The author cannot evaluate its own plan.${planNote}`,
    };
  }
  if (plan.verdict !== 'ready') {
    const escalate = plan.rounds >= 3;
    return {
      step: escalate ? 'plan-disagreement' : 'revise-plan',
      title: escalate ? 'Take the plan disagreement to the user' : 'Revise the plan to resolve the blocking findings',
      actor: escalate ? 'user' : 'auto-developer', skill: 'plan-review', repository: null,
      command: escalate ? `autodev plan show --story ${story}` : `autodev plan submit --story ${story} --file <plan.md>`,
      why: escalate ? `The plan is still not ready after ${plan.rounds} evaluations. A person decides how to proceed.` : `The plan was evaluated as not ready.${planNote}`,
      details: plan.blocking,
    };
  }

  for (const repo of prepared) {
    if (repo.pr) continue;
    if (!repo.cloneExists) {
      return { step: 'prepare-repositories', title: `Prepare ${repo.name} again`, actor: 'auto-developer', skill: 'bitbucket', repository: repo.name, command: `autodev repo prepare --story ${story} --repo ${repo.name}`, why: 'A story branch is recorded but the clone is missing.' };
    }
    if (repo.currentBranch !== repo.featureBranch) {
      return { step: 'wrong-branch', title: `${repo.name} is not on the story branch`, actor: 'user', skill: 'bitbucket', repository: repo.name, command: `autodev repo status --repo ${repo.name}`, why: `The clone is on "${repo.currentBranch}", not "${repo.featureBranch}". Work is not moved between branches automatically.` };
    }
    if (repo.changedFiles === 0 && !repo.dirty) {
      return {
        step: 'implement', title: `Implement the plan in ${repo.name}`, actor: 'auto-developer', skill: 'java-spring', repository: repo.name,
        command: `autodev context --story ${story} --task implement --repo ${repo.name}`,
        why: 'The plan is ready and this repository has no changes yet.',
        details: ['Confirm the plan with the user first if you have not: show them the plan, the P2 findings and what the reviewer could not verify.', ...plan.shouldFix.map((finding) => `Address or have the user accept: ${finding}`)],
      };
    }
    if (repo.dirty) {
      const step = gateStep(facts, repo, repo.worktreeBlockers);
      if (step) return step;
      return { step: 'commit', title: `Commit the change in ${repo.name}`, actor: 'auto-developer', skill: 'bitbucket', repository: repo.name, command: `autodev repo commit --story ${story} --repo ${repo.name} --message "${story}: <what and why>"`, why: 'Tests and both reviews pass for exactly this code.' };
    }
    const step = gateStep(facts, repo, repo.headBlockers);
    if (step) return step;
    return {
      step: 'open-pull-request', title: `Open the pull request for ${repo.name}`, actor: 'auto-developer', skill: 'bitbucket', repository: repo.name,
      command: `autodev pr create --story ${story} --repo ${repo.name} --risks "…" --dependencies "…"`,
      why: 'The change is committed and every gate matches the commit. This usually needs the user\'s approval (APPROVAL_REQUIRED).',
    };
  }
  if (!facts.learningChecked) {
    return {
      step: 'capture-learnings', title: 'Look for what this story should teach the project', actor: 'auto-developer', skill: 'learning-management', repository: null,
      command: `autodev learn suggest --story ${story}`,
      why: 'Every story ends with this check. It lists what went wrong on the way (plan findings, gates that failed) and what keeps recurring across stories, so that a rule can be proposed for the user to approve.',
      details: ['Also propose a rule for any correction the user gave you during this story that will apply again.'],
    };
  }
  return {
    step: 'report', title: 'Report to the user', actor: 'auto-developer', skill: null, repository: null, command: `autodev run show --story ${story}`,
    why: 'Every prepared repository has a pull request.',
    details: [
      'Report the pull request links, what was tested stage by stage, the review outcome, risks and anything left open.',
      ...(facts.pendingApprovals ?? []).map((approval) => `Waiting for the user: ${approval.summary} (autodev approvals review ${approval.id})`),
    ],
  };
}

/**
 * Where a story stands, as a short list for a status line.
 * @param {StoryFacts} facts
 */
export function progress(facts) {
  const { plan } = facts;
  return {
    story: facts.storyRead ? 'read' : 'not read',
    plan: !plan.exists ? 'none' : plan.stale ? 'changed since evaluation' : !plan.evaluated ? 'not evaluated' : String(plan.verdict),
    repositories: facts.repos.filter((repo) => repo.prepared).map((repo) => ({
      name: repo.name,
      changedFiles: repo.changedFiles,
      uncommitted: repo.dirty,
      gatesOutstanding: (repo.dirty ? repo.worktreeBlockers : repo.headBlockers).map((blocker) => blocker.gate),
      pullRequest: repo.pr?.url ?? (repo.pr ? 'pushed, to be opened manually' : null),
    })),
  };
}
