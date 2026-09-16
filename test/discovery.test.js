import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SimulationAdapter } from "../src/adapters/simulation.js";
import { DiscoveryService } from "../src/discovery/service.js";
import { scoreOpportunity } from "../src/discovery/scoring.js";
import { discoveryTitleRelevant } from "../src/discovery/title-preferences.js";
import { ProfileStore } from "../src/profile-store.js";
import { ApplicationService } from "../src/service.js";
import { JsonStore } from "../src/store.js";
import { himalayas } from "../src/discovery/sources/himalayas.js";
import { ashby } from "../src/discovery/sources/ashby.js";
import { lever } from "../src/discovery/sources/lever.js";

test("full-time discovery scores, ingests, and applies to qualifying jobs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-discovery-test-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("applicant-one", {
    contact: {
      firstName: "Applicant", lastName: "Example", email: "applicant-one@example.test",
      phone: "+10000000000", location: "Remote"
    },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["TypeScript", "Node.js"],
    preferences: {
      locations: ["remote"],
      fullTime: { jobTitles: ["Senior Engineer"], automatedDiscoverySources: ["remoteok"] }
    }
  });
  const config = {
    defaultMode: "full_time",
    discovery: { limitPerSource: 10 },
    modes: {
      full_time: {
        minimumScore: 75, dailyApplicationCap: 8, autoApply: true,
        autoApplyDiscovered: true, sources: ["jobicy"], requireConfirmationFor: []
      }
    }
  };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const fetchImpl = async () => new Response(JSON.stringify([
    { legal: "metadata" },
    {
      id: "123", position: "Senior Node.js Engineer", company: "Example",
      description: "TypeScript Node.js platform", tags: ["TypeScript", "Node.js"],
      location: "Worldwide", date: new Date().toISOString(),
      url: "https://remoteok.com/jobs/123", apply_url: "https://remoteok.com/jobs/123"
    }
  ]), { status: 200, headers: { "content-type": "application/json" } });
  const discovery = new DiscoveryService({ applicationService, profiles, config, fetchImpl });
  const result = await discovery.scan({}, { actorId: "applicant-one-openclaw", profileId: "applicant-one" });

  assert.equal(result.found, 1);
  assert.deepEqual(result.sources, ["remoteok"]);
  assert.equal(result.qualifying, 1);
  assert.equal(result.items[0].application.status, "queued");
  await applicationService.waitForIdle();
  assert.equal(applicationService.list("applications", "applicant-one")[0].status, "submitted");
  assert.equal(result.items[0].opportunity.mode, "full_time");
});

test("discovery refuses to search before profile onboarding is complete", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-discovery-test-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  const config = {
    defaultMode: "full_time",
    modes: { full_time: { minimumScore: 75, sources: ["remoteok"] } }
  };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const discovery = new DiscoveryService({ applicationService, profiles, config });
  await assert.rejects(
    discovery.scan({}, { actorId: "applicant-one-openclaw", profileId: "applicant-one" }),
    /profile is missing search fields/
  );
});

test("discovery can find jobs but does not apply with an incomplete application profile", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-discovery-test-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("applicant-two", {
    skills: ["TypeScript", "Node.js"],
    preferences: { locations: ["remote"], fullTime: { jobTitles: ["Senior Engineer"] } }
  });
  const config = {
    defaultMode: "full_time",
    discovery: { limitPerSource: 10 },
    modes: {
      full_time: {
        minimumScore: 75, dailyApplicationCap: 8, autoApply: true,
        autoApplyDiscovered: true, sources: ["remoteok"], requireConfirmationFor: []
      }
    }
  };
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const fetchImpl = async () => new Response(JSON.stringify([
    { legal: "metadata" },
    {
      id: "456", position: "Senior Node.js Engineer", company: "Example",
      description: "TypeScript Node.js platform", tags: ["TypeScript", "Node.js"],
      location: "Worldwide", date: new Date().toISOString(),
      url: "https://remoteok.com/jobs/456"
    }
  ]));
  const discovery = new DiscoveryService({ applicationService, profiles, config, fetchImpl });
  const result = await discovery.scan({}, { actorId: "applicant-two-openclaw", profileId: "applicant-two" });

  assert.equal(result.qualifying, 1);
  assert.equal(result.readyToApply, false);
  assert.equal(result.items[0].application, undefined);
  assert.ok(result.items[0].applicationBlockedByProfile.includes("contact.email"));
});

test("profile hard exclusions override keyword matches", () => {
  const profile = {
    skills: ["Fitness", "Coaching"],
    preferences: {
      locations: ["remote"],
      fullTime: {
        jobTitles: ["Fitness Coach"], remoteOnly: true,
        excludedTitles: ["Gym Manager"]
      }
    }
  };
  const scored = scoreOpportunity({
    title: "Remote Gym Manager", description: "Fitness coaching", remote: true,
    postedAt: new Date().toISOString()
  }, profile, "full_time");
  assert.equal(scored.score, 0);
  assert.match(scored.scoreDetails.hardExclusion, /Gym Manager/);
});

test("secondary job titles are eligible but receive a lower title priority score", () => {
  const profile = {
    skills: ["AI", "Automation", "Node.js", "TypeScript", "APIs", "SaaS"],
    preferences: {
      locations: ["Remote"],
      fullTime: {
        jobTitles: ["AI Engineer", "Backend Engineer"],
        secondaryJobTitles: ["Technical Product Manager", "Solutions Engineer"],
        remoteOnly: true,
        allowedLocations: ["Remote", "Worldwide"]
      }
    }
  };
  const primary = scoreOpportunity({
    title: "Senior AI Engineer", description: "AI Automation Node.js TypeScript APIs SaaS",
    remote: true, location: "Worldwide", postedAt: new Date().toISOString()
  }, profile, "full_time");
  const secondary = scoreOpportunity({
    title: "Technical Product Manager", description: "AI Automation Node.js TypeScript APIs SaaS",
    remote: true, location: "Worldwide", postedAt: new Date().toISOString()
  }, profile, "full_time");
  assert.equal(primary.scoreDetails.titlePriority, "primary");
  assert.equal(secondary.scoreDetails.titlePriority, "secondary");
  assert.ok(primary.scoreDetails.titleScore > secondary.scoreDetails.titleScore);
  assert.ok(secondary.score >= 75);
});

test("curated sources accept configured secondary roles without broad sales roles", () => {
  const profile = { preferences: { fullTime: {
    jobTitles: ["AI Engineer"],
    secondaryJobTitles: ["Technical Product Manager", "Solutions Engineer"]
  } } };
  assert.equal(discoveryTitleRelevant("Senior Technical Product Manager", profile), true);
  assert.equal(discoveryTitleRelevant("Enterprise Solutions Engineer", profile), true);
  assert.equal(discoveryTitleRelevant("Enterprise Account Executive", profile), false);
  assert.equal(discoveryTitleRelevant("Engineering Manager", profile), false);
});

test("opportunistic roles require explicit acceptable pay and strong technical fit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "job-discovery-test-"));
  const profiles = await new ProfileStore(path.join(directory, "profiles.json"), { allowMissing: true }).init();
  await profiles.patch("applicant-one", {
    contact: {
      firstName: "Applicant", lastName: "Example", email: "applicant-one@example.test",
      phone: "+10000000000", location: "Remote"
    },
    documents: { resume: "/secure/resume.pdf" },
    skills: ["AI", "Automation", "Node.js", "TypeScript", "APIs", "SaaS"],
    preferences: {
      locations: ["Remote"],
      fullTime: {
        jobTitles: ["AI Engineer"], remoteOnly: true,
        allowedLocations: ["Remote", "Worldwide"],
        minimumCompensation: 60000, compensationCurrency: "USD", compensationPeriod: "year",
        opportunisticRoles: { enabled: true, minimumMatchedSkills: 5, minimumScore: 65 },
        automatedDiscoverySources: ["remoteok"]
      }
    }
  });
  const config = {
    defaultMode: "full_time", discovery: { limitPerSource: 10 },
    modes: { full_time: {
      minimumScore: 75, dailyApplicationCap: 8, autoApply: true,
      autoApplyDiscovered: true, sources: ["remoteok"], requireConfirmationFor: []
    } }
  };
  const rows = [
    { legal: "metadata" },
    {
      id: "broad-good", position: "Technical Operations Specialist", company: "Good",
      description: "AI Automation Node.js TypeScript APIs SaaS", tags: [], location: "Worldwide",
      date: new Date().toISOString(), url: "https://remoteok.com/jobs/broad-good",
      salary_min: 60000, salary_max: 80000
    },
    {
      id: "broad-unknown-pay", position: "Technical Operations Specialist", company: "Unknown Pay",
      description: "AI Automation Node.js TypeScript APIs SaaS", tags: [], location: "Worldwide",
      date: new Date().toISOString(), url: "https://remoteok.com/jobs/broad-unknown-pay"
    },
    {
      id: "broad-weak", position: "Technical Operations Specialist", company: "Weak",
      description: "AI and SaaS", tags: [], location: "Worldwide",
      date: new Date().toISOString(), url: "https://remoteok.com/jobs/broad-weak",
      salary_min: 60000, salary_max: 80000
    }
  ];
  const store = await new JsonStore(path.join(directory, "state.json")).init();
  const applicationService = new ApplicationService({ store, config, adapter: new SimulationAdapter() });
  const discovery = new DiscoveryService({
    applicationService, profiles, config,
    fetchImpl: async () => new Response(JSON.stringify(rows))
  });
  const result = await discovery.scan({}, { actorId: "applicant-one-openclaw", profileId: "applicant-one" });
  assert.equal(result.found, 3);
  assert.equal(result.qualifying, 1);
  assert.equal(result.items[0].opportunity.title, "Technical Operations Specialist");
  assert.equal(result.items[0].opportunity.scoreDetails.rolePriority, "opportunistic");
});

test("US-only remote jobs are excluded for a European profile", () => {
  const profile = {
    skills: ["Node.js"],
    preferences: { locations: ["Portugal", "Europe"], fullTime: {
      jobTitles: ["Engineer"], allowedLocations: ["Portugal", "Europe"], employmentTypes: ["full_time"]
    } }
  };
  const scored = scoreOpportunity({
    title: "Node.js Engineer", description: "Node.js", remote: true,
    location: "Remote - US only", employmentType: "full-time", postedAt: new Date().toISOString()
  }, profile, "full_time");
  assert.equal(scored.score, 0);
  assert.match(scored.scoreDetails.hardExclusion, /location restriction/);
});

test("a named European-country list still excludes a Portugal-based applicant", () => {
  const scored = scoreOpportunity({
    title: "Senior Full Stack Engineer", description: "React and Node.js", tags: [],
    location: "France, Germany, Netherlands, Spain", remote: true,
    employmentType: "Full-Time"
  }, {
    skills: ["React", "Node.js"],
    preferences: { fullTime: {
      jobTitles: ["Full Stack Engineer"], remoteOnly: true,
      allowedLocations: ["Portugal", "EU", "Europe", "Worldwide"],
      employmentTypes: ["full_time"]
    } }
  }, "full_time");
  assert.match(scored.scoreDetails.hardExclusion, /does not include the applicant residence/);
});

test("a named country list accepts Portugal when it is included", () => {
  const scored = scoreOpportunity({
    title: "Senior Frontend Engineer", description: "React and TypeScript", tags: [],
    location: "Portugal, Croatia, Romania", remote: true,
    employmentType: "Full-Time"
  }, {
    skills: ["React", "TypeScript"],
    preferences: { fullTime: {
      jobTitles: ["Frontend Engineer"], remoteOnly: true,
      allowedLocations: ["Portugal", "EU", "Europe", "Worldwide"],
      employmentTypes: ["full_time"]
    } }
  }, "full_time");
  assert.equal(scored.scoreDetails.hardExclusion, undefined);
});

test("a city-specific remote role excludes an applicant living elsewhere", () => {
  const scored = scoreOpportunity({
    title: "AI Engineer", description: "Python and LLM integrations", tags: [],
    location: "Remote, Bangalore", remote: true, employmentType: "Full-Time"
  }, {
    skills: ["Python", "LLM"],
    preferences: { fullTime: {
      jobTitles: ["AI Engineer"], remoteOnly: true,
      allowedLocations: ["Portugal", "EU", "Europe", "Worldwide"],
      employmentTypes: ["full_time"]
    } }
  }, "full_time");
  assert.match(scored.scoreDetails.hardExclusion, /does not include the applicant residence/);
});

test("explicitly excluded job locations are rejected", () => {
  const profile = {
    skills: ["Node.js"],
    preferences: {
      locations: ["Remote", "Europe"],
      fullTime: {
        jobTitles: ["Engineer"], remoteOnly: true,
        allowedLocations: ["Europe", "Portugal"], excludedLocations: ["Japan"]
      }
    }
  };
  const scored = scoreOpportunity({
    title: "Backend Engineer", description: "Node.js", remote: true,
    location: "Remote — Japan"
  }, profile, "full_time");
  assert.equal(scored.score, 0);
  assert.match(scored.scoreDetails.hardExclusion, /excluded location Japan/);
});

test("known employment and compensation conflicts cannot silently auto-apply", () => {
  const profile = {
    skills: ["Node.js"],
    preferences: { locations: ["Remote"], fullTime: {
      jobTitles: ["Engineer"], employmentTypes: ["full_time"],
      minimumCompensation: 60000, compensationCurrency: "EUR", compensationPeriod: "year"
    } }
  };
  const contract = scoreOpportunity({ title: "Node.js Engineer", description: "Node.js", remote: true,
    location: "Worldwide", employmentType: "contract" }, profile, "full_time");
  assert.match(contract.scoreDetails.hardExclusion, /employment type/);
  const lowPay = scoreOpportunity({ title: "Node.js Engineer", description: "Node.js", remote: true,
    location: "Worldwide", employmentType: "full_time",
    compensation: { maximum: 3000, period: "month", currency: "EUR" } }, profile, "full_time");
  assert.match(lowPay.scoreDetails.hardExclusion, /below the configured minimum/);
  const currency = scoreOpportunity({ title: "Node.js Engineer", description: "Node.js", remote: true,
    location: "Worldwide", employmentType: "full_time",
    compensation: { maximum: 100000, period: "year", currency: "USD" } }, profile, "full_time");
  assert.deepEqual(currency.conflicts, ["compensation_conflict"]);
});

test("compensation floors can distinguish gross, net, and unspecified pay", () => {
  const profile = {
    skills: ["Node.js"],
    preferences: { locations: ["Remote"], fullTime: {
      jobTitles: ["Engineer"], employmentTypes: ["full_time"],
      minimumCompensation: 5000,
      minimumNetCompensation: 3500,
      minimumUnspecifiedCompensation: 3500,
      compensationCurrency: "EUR", compensationPeriod: "month"
    } }
  };
  const opportunity = (maximum, basis) => ({
    title: "Node.js Engineer", description: "Node.js", remote: true,
    location: "Worldwide", employmentType: "full_time",
    compensation: { maximum, period: "month", currency: "EUR", ...(basis ? { basis } : {}) }
  });

  const belowGross = scoreOpportunity(opportunity(4000, "gross"), profile, "full_time");
  assert.match(belowGross.scoreDetails.hardExclusion, /below the configured minimum/);

  const acceptedNet = scoreOpportunity(opportunity(3500, "net"), profile, "full_time");
  assert.equal(acceptedNet.scoreDetails.hardExclusion, undefined);

  const acceptedUnspecified = scoreOpportunity(opportunity(3500), profile, "full_time");
  assert.equal(acceptedUnspecified.scoreDetails.hardExclusion, undefined);

  const belowUnspecified = scoreOpportunity(opportunity(3499), profile, "full_time");
  assert.match(belowUnspecified.scoreDetails.hardExclusion, /below the configured minimum/);
});

test("unknown compensation is neutral and worldwide remote remains eligible", () => {
  const profile = { skills: ["Node.js"], preferences: { locations: ["Remote"], fullTime: {
    jobTitles: ["Engineer"], allowedLocations: ["Portugal", "Europe"], minimumCompensation: 60000,
    compensationCurrency: "EUR"
  } } };
  const scored = scoreOpportunity({ title: "Node.js Engineer", description: "Node.js", remote: true,
    location: "Worldwide", employmentType: "full_time", postedAt: new Date().toISOString() }, profile, "full_time");
  assert.equal(scored.scoreDetails.hardExclusion, undefined);
  assert.equal(scored.scoreDetails.compensationScore, 3);
});

test("Himalayas searches for the applicant country and normalizes remote jobs", async () => {
  let requestedUrl;
  const items = await himalayas.search({
    limit: 1,
    profile: {
      contact: { location: "Lisbon, Portugal" },
      preferences: {
        locations: ["Remote", "Europe", "Portugal"],
        fullTime: { jobTitles: ["AI Engineer"] }
      }
    },
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return new Response(JSON.stringify({ jobs: [{
        guid: "https://himalayas.app/jobs/example-123",
        title: "Senior AI Engineer",
        companyName: "Example",
        applicationLink: "https://himalayas.app/jobs/example-123",
        description: "<p>Python and agentic AI</p>",
        categories: ["AI"],
        parentCategories: ["Developer"],
        seniority: ["Senior"],
        locationRestrictions: ["Portugal", "Germany"],
        employmentType: "Full Time",
        pubDate: 1_789_000_000,
        minSalary: 80_000,
        maxSalary: 100_000,
        salaryPeriod: "annual",
        currency: "EUR"
      }] }));
    }
  });

  assert.equal(requestedUrl.searchParams.get("country"), "portugal");
  assert.equal(requestedUrl.searchParams.get("sort"), "recent");
  assert.equal(items[0].source, "himalayas");
  assert.equal(items[0].location, "Portugal, Germany");
  assert.equal(items[0].description, "Python and agentic AI");
  assert.equal(items[0].compensation.currency, "EUR");
});

test("Ashby curated discovery preserves secondary remote locations", async () => {
  const items = await ashby.search({
    limit: 10,
    sourceConfig: {
      boards: [
        { slug: "example-one", company: "Example One" },
        { slug: "example-two", company: "Example Two" }
      ]
    },
    fetchImpl: async (url) => new Response(JSON.stringify({ jobs: [{
      id: new URL(url).pathname.split("/").pop(), title: "Senior AI Engineer",
      applyUrl: "https://jobs.ashbyhq.com/example/1/application",
      jobUrl: "https://jobs.ashbyhq.com/example/1", descriptionPlain: "Node.js and AI",
      location: "Berlin Office", secondaryLocations: [{ location: "Portugal" }],
      isRemote: true, employmentType: "FullTime", publishedAt: "2026-09-01"
    }] }))
  });
  assert.equal(items.length, 2);
  assert.match(items[0].location, /Portugal/);
  assert.equal(items[0].source, "ashby");
});

test("Lever curated discovery keeps remote engineering roles", async () => {
  const items = await lever.search({
    limit: 10,
    sourceConfig: {
      sites: [
        { slug: "example-one", company: "Example One" },
        { slug: "example-two", company: "Example Two" }
      ]
    },
    fetchImpl: async () => new Response(JSON.stringify([{
      id: "one", text: "Senior Python Engineer", workplaceType: "remote",
      applyUrl: "https://jobs.lever.co/example/one/apply",
      hostedUrl: "https://jobs.lever.co/example/one", descriptionPlain: "Python",
      categories: { location: "Europe", allLocations: ["Europe"], commitment: "Full time" },
      createdAt: 1_789_000_000_000
    }]))
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].location, "Europe");
  assert.equal(items[0].source, "lever");
});
