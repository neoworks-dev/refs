# Refs

**Your own design reference library, collected by a browser that explores websites for you.**

Galleries like Mobbin are great until the site you want to study isn't in them. Refs lets you build that kind of library yourself. You give it a website, and it browses the site the way a curious designer would: it opens the pages, tries the menus and tabs, and saves everything it sees. You end up with a clean, searchable collection of screens, sections and components you can come back to whenever you need inspiration.

## What you get

- **Every page, captured properly.** Refs takes full-page screenshots on desktop and on mobile, waits for images to load, and clicks away cookie banners first.
- **The pieces, not just the pages.** Heroes, pricing sections, navigation bars, buttons, forms and dialogs are cut out on their own, so you can compare them side by side.
- **How it all connects.** Refs remembers which link or button led from one screen to the next, so you can follow a site the way a visitor moves through it.
- **A library that's pleasant to browse.** Sites, screens and elements live in a calm, image-first interface made for looking at design.
- **Yours, on your machine.** Everything is stored locally, and the AI parts run on your own GPU. No subscription, no upload, no account.

## Where it's going

Refs is young, and we're building it in the open.

1. **Capture.** Explore a site, take the screenshots and cut out the elements. This is what we're finishing now.
2. **Understanding.** A local vision model recognises what each page is, such as a pricing page or a signup screen, describes it, and makes everything searchable by what it looks like. You'll be able to type "dark hero with a product screenshot" and find it.
3. **Flows.** The explorer works toward goals, like starting a free trial, and saves the journey as a flow you can step through.
4. **Library.** Browse components across all your sites, save favourites into collections, and switch to a dark theme.

Refs only ever sees what a visitor sees. It never logs in, and it never clicks anything that could buy, delete or change something.

## Trying it out

You'll need [Bun](https://bun.sh) and [Docker](https://www.docker.com).

```sh
bun install
bun run db:up      # start the database
bun run dev        # open the library at http://localhost:5173
bun run crawler    # in a second terminal, the explorer that picks up new sites
```

Then click **Add site**, paste a URL and watch the screens come in.

## Contributing

Ideas, bug reports and pull requests are all welcome. Have a look at the [open issues](https://github.com/neoworks-dev/refs/issues) to see what's planned, or open a new one if something is missing. If you're writing code, [CLAUDE.md](CLAUDE.md) explains how the project is put together and the style we keep to.

## License

[MIT](LICENSE)
