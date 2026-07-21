# Privacy Policy

Last updated: July 18, 2026

## Overview

TetherCode is a companion app for connecting to a bridge service that you run on your own machine. The app is designed for trusted private networking, such as LAN, VPN, or Tailscale. It is not a public multi-tenant shell service.

## Information Processed

TetherCode can process:

- Chat prompts and assistant responses
- Bridge connection details you enter in the app
- Terminal command text and command output returned by your bridge
- Git repository status, diffs, commit messages, and related metadata
- File or image attachments you choose to send
- If notifications are enabled, an Expo push token, notification-routing identifiers, the bridge
  project folder name in generic notification text, and an optional assistant reply preview of at
  most 140 characters

## How Information Is Used

The app uses this information to:

- connect your phone to your self-hosted bridge
- display and continue assistant threads
- execute approved terminal and Git workflows on infrastructure you control
- upload user-selected files and images to your own workflow
- deliver user-enabled turn-completion and approval notifications

## Storage and Retention

TetherCode does not define a separate cloud retention layer for your project data. Data is generally stored by services and infrastructure you control, including your local bridge, repository, logs, caches, and any model providers or integrations that you configure.

## Sharing

TetherCode does not include advertising SDKs. Data may be transmitted to third-party model or infrastructure providers only when you configure and use those services as part of your own setup.

When notifications are enabled, the self-hosted bridge sends the device push token, notification
title/body, and routing/deep-link identifiers through the Expo Push Notification Service and then
APNs or FCM. A completion notification can include the last non-empty line of an assistant reply,
collapsed and capped at 140 characters. Generic completion and approval text can include the bridge
project folder name. Prompts, code, diffs, tool output, and full conversations are not included in
push payloads. Notifications can be disabled in Settings.

## Security

Security depends on how you configure your bridge and network. The app is intended for private LAN,
VPN, or private-overlay use and the bridge must not be exposed directly to the public internet.
Bridge authentication remains required on private networks. You are responsible for protecting
bridge tokens, provider credentials, repository access, and device access.

## Your Responsibility

You are responsible for:

- operating the bridge only on systems you own or are authorized to control
- securing your network path and credentials
- reviewing commands, approvals, and repository actions before execution

## Contact

For support, use the project support channel:

https://github.com/DavidParks8/TetherCode/issues
