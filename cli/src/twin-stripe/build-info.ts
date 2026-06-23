// SPDX-License-Identifier: Apache-2.0

export type TwinBuildInfo = {
  package: string;
  version: string;
  git_sha: string;
  build_time: string;
};

export function twinBuildInfo(): TwinBuildInfo {
  return {
    package: "@pome-sh/twin-stripe",
    version: process.env.POME_TWIN_VERSION ?? "0.1.0",
    git_sha: process.env.POME_TWIN_GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
    build_time: process.env.POME_TWIN_BUILD_TIME ?? "dev",
  };
}
