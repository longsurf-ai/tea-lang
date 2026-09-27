// Purpose: Keep Tea learning documentation separate from mechanical reference lookup.

import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  documentationSidebar: [
    'introduction',
    {
      type: 'category',
      label: 'Getting Started',
      items: [
        'getting-started/Write your first indicator',
        'getting-started/backtest-your-strategy',
        'getting-started/live-scanner',
        'getting-started/live-trading',
      ],
    },
    {
      type: 'category',
      label: 'Language Guide',
      items: [
        'language-guide/program-structure',
        'language-guide/execution-model',
        'language-guide/values-and-control-flow',
        'language-guide/time-series',
        'language-guide/outputs-and-events',
        'imports',
        'requests',
        {
          type: 'doc',
          id: 'strategy',
          label: 'Strategy Model',
        },
        {
          type: 'doc',
          id: 'memory-model',
          label: 'Memory Model',
        },
      ],
    },
    {
      type: 'category',
      label: 'Advanced',
      items: [
        'advanced/tea-compiler',
        {
          type: 'doc',
          id: 'ir',
          label: 'Tea IR',
        },
        'advanced/gpu-lowering',
        'geometry',
      ],
    },
  ],
  referenceSidebar: [
    'reference/overview',
    referenceCategory('Types', 'types', ['reference/types/array']),
    referenceCategory('Variables', 'variables', ['reference/variables/close']),
    referenceCategory('Constants', 'constants', [
      'reference/constants/color/red',
    ]),
    referenceCategory('Functions', 'functions', [
      'reference/native-functions',
      'reference/functions/array/push',
      'reference/libraries/ta',
      'reference/libraries/visual',
      'reference/libraries/pine',
      'reference/libraries/geometry',
      'reference/libraries/broker',
      'reference/libraries/portfolio',
      'reference/libraries/trade',
    ]),
    referenceCategory('Keywords', 'keywords', [
      'reference/keywords/for-in',
      'reference/keywords/emit',
      'reference/keywords/return',
    ]),
    referenceCategory('Operators', 'operators', [
      'reference/operators/history',
    ]),
    referenceCategory('Annotations', 'annotations', [
      'reference/annotations/version',
    ]),
  ],
};

function referenceCategory(label: string, landing: string, items: string[]) {
  return {
    type: 'category' as const,
    label,
    link: {type: 'doc' as const, id: `reference/${landing}`},
    items,
  };
}

export default sidebars;
