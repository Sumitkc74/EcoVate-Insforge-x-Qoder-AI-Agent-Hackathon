## About EcoVate

EcoVate is an AI-powered circular-economy platform that uses a coordinated multi-agent system to scan and identify items, research sustainable reuse options, and verify recommendations for practical environmental action.

Built during the Insforge x Qoder AI Agent Hackathon.

**Team:** Namrata Mali, Ayush Kumar Gupta, Ritish Upadhyayula, Sumit K C

## My Contribution

I implemented the multi-agent coordination workflow, connecting item scanning with vision analysis, sustainability research, DIY reuse recommendations, and verification so users receive practical and trustworthy actions for each item.

## Getting Started

### Prerequisites

- Node.js 20 or later
- npm

### Installation

Clone the repository and install the dependencies:

```bash
git clone https://github.com/Sumitkc74/EcoVate-Insforge-x-Qoder-AI-Agent-Hackathon.git
cd EcoVate-Insforge-x-Qoder-AI-Agent-Hackathon
npm install
```

The app includes a default InsForge URL, but an anonymous key is required for
authentication and backend features. To configure the connection for local
development, create a `.env.local` file in the project root:

```env
NEXT_PUBLIC_INSFORGE_URL=your_insforge_url
NEXT_PUBLIC_INSFORGE_ANON_KEY=your_insforge_anon_key
INSFORGE_SERVICE_KEY=your_insforge_service_key
```

Keep `INSFORGE_SERVICE_KEY` server-side and do not expose or commit it.

### Run the development server

Start the app locally:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Other commands

Run the linter:

```bash
npm run lint
```

Build and run the production version:

```bash
npm run build
npm run start
```

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
