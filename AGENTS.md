# Architecture decisions

- The instruction token status bar uses the active editor buffer and the same offline safety scanner as diagnostics; estimates are not billed model usage — why: immediate value requires no login, network, or AI spend.
- File recognition is shared by diagnostics, token footprint, and CodeLens — why: supported instruction formats must behave consistently.