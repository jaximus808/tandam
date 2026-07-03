/* Starter content for the zero-tabs welcome page (roadmap item 10). Instead of
   one-click templates, the welcome page now leads with what you can ask your
   agent to build — each capability doubles as a copyable example prompt. */

export interface Capability {
  emoji: string;
  /** What kind of thing the agent can build. */
  title: string;
  /** One line on what it's good for. */
  blurb: string;
  /** A ready-to-copy prompt that produces this. */
  prompt: string;
}

// The breadth of the canvas — "stuff it can do." Each card is also a prompt you
// can copy and paste to your agent to try it.
export const CAPABILITIES: Capability[] = [
  {
    emoji: "🗺️",
    title: "Maps",
    blurb: "Drop pins, plot places, cluster a whole region.",
    prompt: "Drop a pin for the top 10 US national parks, with a one-line note on each.",
  },
  {
    emoji: "📅",
    title: "Itineraries",
    blurb: "Day-by-day schedules linked to the map.",
    prompt: "Plan a 7-day US road trip as a day-by-day itinerary with a map pin for each stop.",
  },
  {
    emoji: "📊",
    title: "Spreadsheets",
    blurb: "Live rows and columns for any kind of data.",
    prompt: "Make a trip budget spreadsheet with columns for category, item, and cost.",
  },
  {
    emoji: "🧭",
    title: "Roadmaps",
    blurb: "Kanban goals and tasks you can drag around.",
    prompt: "Outline a product roadmap with goals grouped into Now, Next, and Later.",
  },
  {
    emoji: "📝",
    title: "Notes",
    blurb: "Free-form markdown docs alongside everything else.",
    prompt: "Write a packing checklist for a two-week road trip.",
  },
  {
    emoji: "📈",
    title: "Charts",
    blurb: "Turn any sheet into a live chart.",
    prompt: "Chart the monthly spend from the budget sheet as a bar chart.",
  },
];

// A few cross-cutting prompts that mix document types — "things to try" that show
// the agent building a whole workspace, not just one tab.
export const STARTER_PROMPTS: string[] = [
  "Plan a long weekend in a US city: a map of stops plus a day-by-day itinerary.",
  "Build a reading list as a spreadsheet with title, author, and status.",
  "Sketch a launch plan as a roadmap with tasks I can check off.",
  "Turn my rough notes into key decisions and a list of action items.",
];
