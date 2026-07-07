// SPDX-License-Identifier: Apache-2.0
//
// The `/healthz` `runtime` block required by the runtime contract. Values
// come from the POME_TWIN_* env surface the cloud injects at image build /
// snapshot time; everything defaults to dev markers locally.

export interface TwinBuildInfo {
  package: string;
  version: string;
  git_sha: string;
  build_time: string;
}

export function twinBuildInfo(packageName: string): TwinBuildInfo {
  return {
    package: packageName,
    version: process.env.POME_TWIN_VERSION ?? "0.1.0",
    git_sha: process.env.POME_TWIN_GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
    build_time: process.env.POME_TWIN_BUILD_TIME ?? "dev",
  };
}
