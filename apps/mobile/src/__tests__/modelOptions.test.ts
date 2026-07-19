import type { ModelOption } from '../api/types';
import { formatModelOptionDescription, formatModelOptionLabel } from '../modelOptions';

function model(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    id: 'model-id',
    displayName: 'Model Name',
    ...overrides,
  };
}

describe('model option formatting', () => {
  it('formats default, provider-qualified, and plain labels', () => {
    expect(formatModelOptionLabel(null)).toBe('Default model');
    expect(formatModelOptionLabel(model({ providerName: ' Provider ' }))).toBe(
      'Provider · Model Name'
    );
    expect(formatModelOptionLabel(model({ providerName: ' ' }))).toBe('Model Name');
  });

  it('uses the id when no description metadata is available', () => {
    expect(formatModelOptionDescription(model())).toBe('model-id');
  });

  it.each([
    [999, '999'],
    [1_000, '1.0K'],
    [9_900, '9.9K'],
    [10_000, '10K'],
    [1_000_000, '1.0M'],
    [9_900_000, '9.9M'],
    [10_000_000, '10M'],
  ])('formats a %i-token context window as %s', (contextWindow, expected) => {
    expect(formatModelOptionDescription(model({ contextWindow }))).toBe(
      `${expected} context`
    );
  });

  it('joins trimmed provider, description, and context metadata', () => {
    expect(
      formatModelOptionDescription(
        model({
          providerName: ' Provider ',
          description: ' Description ',
          contextWindow: 128_000,
        })
      )
    ).toBe('Provider · Description · 128K context');
  });
});
