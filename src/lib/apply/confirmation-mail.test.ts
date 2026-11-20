import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAccountMailSubject, isApplicationConfirmationMail, namesJob } from "./confirmation-mail";

const jiostar = { company: "JioStar", jobTitle: "Senior Software Development Engineer" };

describe("application confirmation mail", () => {
  it("accepts Workday thank-you and application-received mail for this job", () => {
    assert.equal(
      isApplicationConfirmationMail(
        {
          subject: "Khushal, thank you for applying!",
          text: "Thank you for applying to Senior Software Development Engineer at JioStar. We have received your application.",
        },
        jiostar,
      ),
      true,
    );
    assert.equal(
      isApplicationConfirmationMail(
        {
          subject: "Application Received for Senior Software Development Engineer",
          html: "<p>Dear Khushal,</p><p>Thank you for applying for the role of Senior Software Development Engineer at JioStar. Your application has been successfully submitted.</p>",
        },
        jiostar,
      ),
      true,
    );
  });

  it("accepts Greenhouse / Ashby thank-you subjects that name the company", () => {
    assert.equal(
      isApplicationConfirmationMail(
        { subject: "Thank you for applying to Acme Robotics", text: "We received your application." },
        { company: "Acme Robotics", jobTitle: "Backend Engineer" },
      ),
      true,
    );
  });

  it("rejects password-reset, verify, and security-code mail even when they name the job", () => {
    assert.equal(isAccountMailSubject("Reset your JioStar password"), true);
    assert.equal(
      isApplicationConfirmationMail(
        {
          subject: "Reset your password",
          text: "Click to reset your JioStar candidate password for Senior Software Development Engineer.",
        },
        jiostar,
      ),
      false,
    );
    assert.equal(
      isApplicationConfirmationMail(
        { subject: "Verify your account", text: "Activate your JioStar candidate account." },
        jiostar,
      ),
      false,
    );
    assert.equal(
      isApplicationConfirmationMail(
        { subject: "Security code for your application to JioStar", text: "Your code is X7kQ2pLm" },
        jiostar,
      ),
      false,
    );
  });

  it("rejects a thank-you for a different company", () => {
    assert.equal(
      isApplicationConfirmationMail(
        { subject: "Thank you for applying to Northern Trust", text: "We have received your application." },
        jiostar,
      ),
      false,
    );
  });

  it("matches the company or a long job title after stripping punctuation", () => {
    assert.equal(namesJob("Thanks for applying at Jio-Star careers", "JioStar"), true);
    assert.equal(namesJob("Application received", "JioStar"), false);
    assert.equal(namesJob("Senior Software Development Engineer", "Senior Software Development Engineer"), true);
    assert.equal(namesJob("Thanks for applying", "Engineer", 10), false);
  });
});
