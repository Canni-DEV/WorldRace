import { defineConfig } from 'vite';

const resolveBasePath = (): string => {
  const repositorySlug = process.env.GITHUB_REPOSITORY;
  const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';

  if (!isGitHubActions || typeof repositorySlug !== 'string') {
    return '/';
  }

  const segments = repositorySlug.split('/');
  const repoName = segments[1];

  if (typeof repoName !== 'string' || repoName.length === 0) {
    return '/';
  }

  return `/${repoName}/`;
};

export default defineConfig({
  base: resolveBasePath(),
});
