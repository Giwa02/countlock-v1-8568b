# CountLock V1 Supervisor Review

## Review triggers

A kit needs review when:

1. Expected count does not match detected count.
2. A part group is skipped.
3. The operator finishes with incomplete counts.
4. AI confidence is low.

## Review action

1. Open the email.
2. Review the mismatched part groups.
3. Physically inspect the kit.
4. Approve, correct, or rebuild the kit.
5. Save the final result.

## Version 1 limitation

Images are stored locally in the browser session for pilot use. Production version should upload evidence images to Supabase Storage or another approved storage system.
