import syntaxHighlight from "@11ty/eleventy-plugin-syntaxhighlight";
import { parse } from "csv-parse/sync";

export default function(eleventyConfig) {
  // Add CSV Data Support
  eleventyConfig.addDataExtension("csv", (contents) => {
    return parse(contents, {
      columns: true,
      skip_empty_lines: true
    });
  });
  // Copy assets to output folder
  eleventyConfig.addPassthroughCopy("assets");
  eleventyConfig.addPassthroughCopy("cv.pdf");

  // Add syntax highlighting
  eleventyConfig.addPlugin(syntaxHighlight);

  // Date formatting filter
  eleventyConfig.addFilter("postDate", (dateObj) => {
    return new Date(dateObj).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC"
    });
  });

  // Configure Markdown processing options
  eleventyConfig.setQuietMode(true);

  return {
    dir: {
      input: ".",
      includes: "_includes",
      output: "_site"
    },
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk"
  };
}
