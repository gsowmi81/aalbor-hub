# Materials for a job

On the job's **Materials** section.

1. **Load the lines.** **Load the Cabinet Vision cut list** (a CSV: the code in the first column, the quantity in the last number column) or **Add a line** by hand. Codes the hub doesn't know go to a one-time match page; the match is remembered. Tick "From the nested file" when the sheet counts are the real ones.
2. **Source.** The hub takes free stock first (leaving what jobs with an earlier factory date still need, unless unticked), then stock already on order (that much of the order becomes this job's), and lists the rest on the order list for this job, to be ordered by the factory date less the supplier's lead days.
3. **Watch the pill.** The job's top shows Materials: ready to cut, on order (with the expected date, and a warning if that's after the factory date), or short. The same shows on the Pipeline's Materials cell and under Short for the factory on Attention and Need and supply.
4. **Pick.** When the factory starts, **Pick for the factory** takes the allocated lines off the shelf as picked moves.

Lines can be removed and reloaded; the same code loaded again replaces the line.
