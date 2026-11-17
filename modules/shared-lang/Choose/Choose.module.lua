local getArgs = require("Module:Arguments").getArgs;

local p = {}

-- Note to dev wiki editors: this function is copied from Module:Example.
-- Changes to this function should be synced with the source.
local function unescape(text)
	if not text:match("UNIQ") then
		return text;
	end
	local unescaped = mw.text.unstripNoWiki(text);
	local text, count = string.gsub(unescaped, "&lt;", "<");
	text, count = string.gsub(text, "&gt;", ">");
	text, count = string.gsub(text, "<//nowiki>", "</nowiki>");
	return text;
end

local function applyFormat(option, args)
	local format = args['format'] or ""
	if format == "template" then
		local template = args['template']
		if not template then
			error('The "template" argument must be supplied.')
		end
		return "{{" .. template .. "|1=" .. option .. "}}"
	elseif format == "userformat"then
		local userformat = args['userformat']
		if not userformat then
			error('The "userformat" argument must be supplied.')
		end
		local raw = unescape(userformat)
		return string.gsub(raw, "%%s", option)
	else
		return option
	end
end

local function getWeight(args, i)
	local weight = tonumber(args["weight" .. i])

	if weight == nil then
		return 1
	end

	if weight < 0 then
		error('Weight "weight' .. i .. '" must not be negative.')
	end

	return weight
end

local function chooseWeightedIndex(weights)
	local count = #weights

	-- No options available.
	if count == 0 then
		return nil
	end

	local total = 0

	for _, weight in ipairs(weights) do
		total = total + weight
	end

	-- All weights are zero: choose uniformly at random.
	if total <= 0 then
		return math.random(count)
	end

	local r = math.random() * total

	for i, weight in ipairs(weights) do
		r = r - weight

		if r < 0 then
			return i
		end
	end

	return count
end

function p.main(frame)
	local args = getArgs(frame)

	local container = mw.html.create("div")
	container:addClass("gadget-choose")
	
	local options = {}
	local weights = {}

	for i, option in ipairs(args) do
		local weightKey = "weight" .. i
		local weight = getWeight(args, i);

		local content = applyFormat(option, args)

		local optionDiv = mw.html.create("div")
		optionDiv:addClass("gadget-choose-option")

		if weight then
			optionDiv:attr("data-weight", weight)
		end

		optionDiv:wikitext(content)
		table.insert(weights, weight)
		table.insert(options, optionDiv)
	end
	
	local selected = chooseWeightedIndex(weights)
	
	for i, option in ipairs(options) do
		if selected and i ~= selected then
			option:css("display", "none")
		end
		container:node(option)
	end

	local result = tostring(container)

	if args['format'] then
		return frame:preprocess(result)
	end

	return result
end

return p