import type { Html, HtmlBuilder } from "foldkit/html";

import { defaultFilters } from "../../client/board/filters.js";
import type { MessageValue } from "../../client/board/message.js";
import { boardUrl, informationRouter } from "../../client/route.js";
import type { InformationPageValue } from "../../client/route.js";

const pages = {
  About: {
    description:
      "Engineering leadership roles for Canada, the US and British Columbia, with links to the original postings.",
    sections: [
      {
        heading: "Built for engineering leaders",
        paragraphs: [
          "Rowland Ekemezie runs this board for people looking for engineering manager, director, head of engineering and VP roles. Its focus is remote work in Canada and the US, and roles in Vancouver and British Columbia.",
          "Every listing is public and links to the original employer or source posting. You can browse, search and keep a shortlist without paying. Pro adds salary and seniority filters, alerts and company information; it does not sell access to listings.",
        ],
      },
      {
        heading: "Coverage and freshness",
        paragraphs: [
          "The board reads public company boards and job feeds. It classifies titles and locations, removes duplicate company/title matches, and prefers the company board when the same role appears in multiple sources.",
          "Fetches follow each source's schedule and back off after failures. When a company board no longer lists a role, the role leaves the board. Aggregators return only their newest postings, so a role one of them stops listing stays until 30 days after it was posted. Listings unseen for 30 days are removed. The board's refresh status describes ingestion, not a guarantee that an employer is still accepting applications.",
          "Location and salary information may be incomplete or classified incorrectly. Check work eligibility, compensation and availability on the original posting before applying. Report a mismatch with the job link and the source evidence.",
        ],
      },
    ],
    title: "About this board",
  },
  Contact: {
    description:
      "Contact Rowland Ekemezie about this job board, incorrect listings, account data or support.",
    sections: [
      {
        heading: "Get help",
        paragraphs: [
          "This board is run by Rowland Ekemezie in Vancouver, British Columbia, Canada. Use the email link below for board questions, incorrect listings, account help or source-owner requests.",
          "For a listing problem, include its board URL, the original posting and what looks wrong. For account or billing help, write from the email address used for that account. Never send passwords, sign-in links, agent tokens or payment-card details.",
        ],
      },
      {
        heading: "Request account deletion or a data correction",
        paragraphs: [
          "Email a request from your account address with the subject Jobs account deletion or Jobs data correction. This is a manual support request, not an immediate deletion button. Ownership must be verified before account data is changed.",
          "If you have a subscription, mention it so billing can be checked before deletion. Account deletion and subscription cancellation are separate operations. A browser-only shortlist must be cleared in that browser; deleting an account does not erase localStorage on your devices.",
        ],
      },
    ],
    title: "Contact and support",
  },
  Privacy: {
    description:
      "What this job board stores for sign-in, saved jobs, searches and billing, and how to request help with your data.",
    sections: [
      {
        heading: "Browsing and accounts",
        paragraphs: [
          "You can read listings without an account. The hosting and security services process request information, such as network addresses and browser metadata, to deliver and protect the site. Sign-in uses a session cookie. Sign-in requests are rate limited.",
          "An account stores an identifier, email address and profile name, along with authentication and session records. A connected sign-in provider processes its own sign-in flow. Your email address is used for requested sign-in messages and saved-search notifications.",
        ],
      },
      {
        heading: "Product analytics",
        paragraphs: [
          "The board collects product analytics with PostHog, such as page views, searches, filter changes and clicks on Apply, to learn which features help. Analytics are cookieless: no analytics cookie or browser storage is set, and each visit gets a new random identifier.",
          "There are no session recordings and no capture of what you type; a search is counted by its length, not its text. When you are signed in, events carry your internal account identifier, never your email address. Events pass through this site, so your network address is not sent to PostHog. Browsers that send Do Not Track or Global Privacy Control are not tracked.",
        ],
      },
      {
        heading: "Saved jobs, searches and tokens",
        paragraphs: [
          "While signed out, saved and applied jobs live in localStorage in your browser. When signed in, the application tracker stores job snapshots, stages, dates and notes with your account. Moving a browser shortlist into an account requires your explicit action.",
          "Saved searches store your chosen search text, roles and regions. You can delete saved searches from your account and use the unsubscribe link in a digest. Agent tokens are stored as hashes; a token's secret is shown when issued and should be kept private.",
          "Account and tracker data do not follow the public listings' 30-day pruning rule. Remove saved items or searches using the product controls, or contact the operator for an account-data request. Browser storage remains until you clear it in that browser.",
        ],
      },
      {
        heading: "Payments and other services",
        paragraphs: [
          "When billing is available, Stripe handles checkout and payment details. The board stores customer and subscription references, plan and entitlement information. Cloudflare provides hosting, database, security and delivery services. Service providers may process information outside Canada.",
          "Opening an original job posting takes you to another service with its own privacy practices. This board does not sell candidate data. For access, correction or deletion requests, use the contact page. Identity and any billing obligations must be checked before a request is completed.",
        ],
      },
    ],
    title: "Privacy",
  },
  Terms: {
    description:
      "How to use the public job listings, source links, account features and Pro tools on this board.",
    sections: [
      {
        heading: "Listings and applications",
        paragraphs: [
          "The board helps you discover engineering leadership roles. Employers and source sites control their postings, application processes and hiring decisions. Apply using the original posting and confirm its location, eligibility, compensation and closing status there.",
          "Listings and classifications can be incomplete, delayed or incorrect. A listing is not an offer of employment or a promise of an interview. Report errors or source-owner concerns through the contact page.",
        ],
      },
      {
        heading: "Accounts and Pro",
        paragraphs: [
          "Browsing listings is public. Keep account sign-in links and agent tokens private, and use account features only for data you are entitled to manage. Do not try to access another person's tracker or bypass service limits.",
          "Pro features and prices are described on the pricing page. Checkout, when available, shows the price and billing interval before payment. Review subscription status and cancellation through the account's billing controls. Deleting a saved search is separate from cancelling a subscription.",
        ],
      },
      {
        heading: "Sources",
        paragraphs: [
          "Original postings belong to their respective employers and publishers. Attribution and a link to the source are included with listings. Source permissions can limit which jobs appear in alerts, paid features or agent tools, even when a listing can be read publicly.",
        ],
      },
    ],
    title: "Using this board",
  },
};

export const informationMeta = (page: InformationPageValue) => ({
  description: pages[page].description,
  title: pages[page].title,
});

export const informationPage = (
  page: InformationPageValue,
  h: HtmlBuilder<MessageValue>
): Html => {
  const content = pages[page];

  return h.article(
    [h.Class("detail")],
    [
      h.h1([h.Class("detail-title")], [content.title]),
      ...content.sections.map((section) =>
        h.section(
          [],
          [
            h.h2([], [section.heading]),
            ...section.paragraphs.map((paragraph) => h.p([], [paragraph])),
          ]
        )
      ),
      h.p(
        [],
        [
          h.a(
            [h.Href("mailto:hello@rowlandekemezie.com?subject=Jobs%20board")],
            ["Email Rowland"]
          ),
          " · ",
          h.a(
            [h.Href(informationRouter("Contact"))],
            ["Contact and data requests"]
          ),
          " · ",
          h.a([h.Href(boardUrl(defaultFilters))], ["Browse open roles"]),
        ]
      ),
    ]
  );
};
