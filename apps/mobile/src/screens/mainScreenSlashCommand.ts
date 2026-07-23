import { executePlanCommand } from './mainScreenPlanCommand';
import { formatCollaborationModeLabel, parseSlashCommand, findSlashCommandDefinition, isSlashCommandAvailable } from './mainScreenHelpers';
import type { MainScreenSlashCommandHandlerContext } from './mainScreenSlashCommandHandler';

export async function executeSlashCommand(context: MainScreenSlashCommandHandlerContext, input: string): Promise<boolean> {
  const {
    setError,
    selectedChatId,
    supportsGoal,
    supportsPlanMode,
    supportsReview,
    activeAgentLabel,
    openAgentThreadSelectorRef,
    ensureLocalCommandChat,
    activeSlashCommands,
    appendLocalAssistantMessage,
    activeAgentId,
    startNewChat,
    setActivity,
    preferredStartCwd,
    selectedChat,
    activeModelLabel,
    activeEffortLabel,
    selectedCollaborationMode,
    supportsFastMode,
    fastModeEnabled,
    onOpenGit,
  } = context;

      const parsed = parseSlashCommand(input);
      if (!parsed) {
        return false;
      }

      const { name: rawName, args } = parsed;
      const commandDef = findSlashCommandDefinition(rawName);
      const name = commandDef?.name ?? rawName;
      const argText = args.trim();

      if (!commandDef) {
        return false;
      }

      if (!commandDef.mobileSupported) {
        setError(commandDef.availabilityNote ?? `/${name} is not supported on mobile.`);
        return true;
      }

      if (commandDef.requiresOpenChat && !selectedChatId) {
        setError(`/${name} requires an open chat`);
        return true;
      }

      if (
        !isSlashCommandAvailable(commandDef, {
          hasOpenChat: Boolean(selectedChatId),
          supportsGoal,
          supportsPlanMode,
          supportsReview,
        })
      ) {
        setError(`/${name} is not supported for ${activeAgentLabel} chats.`);
        return true;
      }

      if (name === 'agent') {
        await openAgentThreadSelectorRef.current(argText || null);
        return true;
      }

      if (name === 'help') {
        const commandChatId = await ensureLocalCommandChat(input);
        if (!commandChatId) {
          return true;
        }
        const lines = activeSlashCommands.map((command) => {
          const suffix = command.argsHint ? ` ${command.argsHint}` : '';
          const scope = command.mobileSupported ? 'mobile' : 'CLI only';
          return `/${command.name}${suffix} — ${command.summary} (${scope})`;
        });
        appendLocalAssistantMessage(
          `Supported slash commands:\n${lines.join('\n')}`,
          commandChatId
        );
        return true;
      }

      if (name === 'new') {
        if (activeAgentId) startNewChat(activeAgentId);
        return true;
      }

      if (name === 'model') {
        setError('This ACP agent does not advertise configurable models.');
        return true;
      }

      if (name === 'plan') {
        return executePlanCommand(context, argText);
      }

      if (name === 'status') {
        const commandChatId = await ensureLocalCommandChat(input);
        if (!commandChatId) {
          return true;
        }
        const lines = [
          `Model: ${activeModelLabel}`,
          `Reasoning: ${activeEffortLabel}`,
          `Mode: ${formatCollaborationModeLabel(selectedCollaborationMode)}`,
          `Default workspace: ${preferredStartCwd ?? 'Select project'}`,
        ];
        if (supportsFastMode) {
          lines.splice(2, 0, `Fast mode: ${fastModeEnabled ? 'On' : 'Off'}`);
        }
        if (selectedChat) {
          lines.push(`Chat: ${selectedChat.title || selectedChat.id}`);
          lines.push(`Chat workspace: ${selectedChat.cwd ?? 'Not set'}`);
          lines.push(`Chat status: ${selectedChat.status}`);
        }
        appendLocalAssistantMessage(lines.join('\n'), commandChatId);
        return true;
      }

      if (name === 'review') {
        if (!selectedChatId) {
          setError('/review requires an open chat');
          return true;
        }

        if (!supportsReview) {
          const detail = `Review is not supported for ${activeAgentLabel} chats.`;
          setError(detail);
          setActivity({
            tone: 'error',
            title: 'Review unavailable',
            detail,
          });
          return true;
        }

        try {
          setActivity({
            tone: 'running',
            title: 'Starting review',
          });
          throw new Error('Review is not advertised by this ACP agent.');
        } catch (err) {
          setError((err as Error).message);
          setActivity({
            tone: 'error',
            title: 'Review failed',
            detail: (err as Error).message,
          });
        }
        return true;
      }

      if (name === 'diff') {
        if (!selectedChat) {
          setError('/diff requires an open chat');
          return true;
        }

        onOpenGit(selectedChat);
        return true;
      }

      return false;


}
