// Purpose: Keep Tea learning documentation separate from mechanical reference lookup.

import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  documentationSidebar: [
    'introduction',
    {
      type: 'category',
      label: 'Getting Started',
      items: [
        'getting-started/write-your-first-indicator',
        'getting-started/backtest-your-strategy',
        'getting-started/parameter-sweep-with-gpu',
        'getting-started/instrument-sweep-with-gpu',
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
      ],
    },
  ],
  referenceSidebar: [
    {
      type: 'doc',
      id: 'reference/types',
      label: 'Types',
    },
    {
      type: 'doc',
      id: 'reference/functions',
      label: 'Functions',
    },
  ],
};

export default sidebars;
