# Open Source License Requirements

This project includes third-party open source software through npm and Cargo dependencies.

## Distribution Requirements

When distributing this project (internal, TestFlight, enterprise, or public):

1. Include a project license file at the repository root (`LICENSE`).
2. Preserve copyright and license notices from all third-party dependencies.
3. Provide a third-party notices document with shipped builds.
4. Keep dependency license metadata available for audit.

## Third-Party Notices

At minimum, generate and keep a `THIRD_PARTY_NOTICES` file for each release build that includes:

- package/crate name
- version
- license identifier
- attribution text when required by license

The mobile runtime directly depends on `@ag-ui/core` version `0.0.57` under the MIT License.
Include its distributed `LICENSE` text in generated mobile notices.

The Rust bridge directly depends on `agent-client-protocol` version `1.2.0`
with the `unstable_elicitation` feature. Include its Apache-2.0 license text
and any transitive notices required by the resolved Cargo lockfile in bridge
distribution notices.

The macOS desktop shell uses operating-system SwiftUI/AppKit frameworks and bundles only the Rust
operator and Rust bridge. Include generated `THIRD_PARTY_NOTICES.txt` for both Cargo dependency
closures and the TetherCode license in every distributed `.app` or archive.

## Practical Policy

- Do not remove existing license headers from source files.
- Do not copy code/assets from external projects unless the license allows redistribution.
- If a dependency license is copyleft or has notice obligations, ensure notices are included before shipping.
- Re-run license checks whenever dependencies change.

## App Distribution Note

For mobile and desktop distributions, ensure the same third-party notices used for
repository/release artifacts are also available for app review and legal compliance workflows.
