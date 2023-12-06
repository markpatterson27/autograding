import {execSync} from 'child_process'
import {v4 as uuidv4} from 'uuid'
import path from 'path'
import * as fs from 'fs'
import chalk from 'chalk'
import * as core from '@actions/core'
import {setCheckRunOutput} from './output'

const color = new chalk.Instance({level: 1})

const defaultEnv = {
  PATH: process.env.PATH,
  FORCE_COLOR: 'true',
  DOTNET_CLI_HOME: '/tmp',
  DOTNET_NOLOGO: 'true',
  HOME: process.env.HOME,
}

export type TestComparison = 'exact' | 'included' | 'regex'

export interface Test {
  readonly name: string
  readonly setup: string
  readonly run: string
  readonly input?: string
  readonly output?: string
  readonly timeout: number
  readonly points?: number
  readonly comparison: TestComparison
}

function btoa(str: string) {
  return Buffer.from(str).toString('base64')
}

// create tmp dir for feedback files
function createFeedbackDir(): string {
  // get runner tmp dir
  const tmpDir = process.env['RUNNER_TEMP'] || '/tmp'
  const feedbackDir = path.join(tmpDir, '_autograding_feedback')
  fs.mkdirSync(feedbackDir, { recursive: true })
  return feedbackDir
}

// compare output to expected output
function compareOutput(output: string, expected: string, method: TestComparison) {
  switch (method) {
    case 'exact':
      return output === expected
    case 'included':
      return output.includes(expected)
    case 'regex': {
      const regex = new RegExp(expected)
      return regex.test(output)
    }
    default:
      throw new Error(`Invalid comparison method: ${method}`)
  }
}

// function getErrorMessageAndStatus(error: Error, command: string) {
//   if (error.message.includes('ETIMEDOUT')) {
//     return { status: 'error', errorMessage: 'Command timed out' }
//   }
//   if (error.message.includes('command not found')) {
//     return { status: 'error', errorMessage: `Unable to locate executable file: ${command}` }
//   }
//   if (error.message.includes('Command failed')) {
//     return { status: 'fail', errorMessage: 'failed with exit code 1' }
//   }
//   return  { status: 'error', errorMessage: error.message }
// }

// run test command and return output or error
function executeTest(command: string, input: string, timeout: number, cwd: string, feedbackFile: string): {output?: string, error?: string} {
  try {
    // merge feedback file path into env
    const env = {
      ...defaultEnv,
      AUTOGRADING_FEEDBACK: feedbackFile,
    }
    const output = execSync(command, {
      cwd,
      input,
      timeout,
      env
    })
      .toString()
      .trim()
    return {
      output,
    }
  } catch (e) {
    let message = ''
    if (e instanceof Error) {
      message = e.message.includes('ETIMEDOUT') ? 'Command was killed due to timeout' : e.message
    } else {
      message = `Failed to execute run test: ${test.name}: ${e}`
    }
    return {
      error: message,
    }
  }
}

// run specific grading tests. assume test is passed unless error or output mismatch
function runTest(test: Test, cwd: string, feedbackDir: string) {
  let timeout = test.timeout * 60 * 1000  // convert to ms
  let status = 'pass'
  let err_message = null
  let score = test.points || null
  let feedback = null
  let execution_time = null

  try {
    // if setup command exists, run it
    if (test.setup) {
      const startSetup = new Date().getTime()

      console.log(`Running setup command: ${test.setup}`)
      execSync(test.setup, {
        cwd,
        timeout,
        stdio: 'ignore',
        env: defaultEnv,
      })

      timeout -= (new Date().getTime() - startSetup)
    }

    // create unique filename for feedback messages
    const feedbackPath = path.join(feedbackDir, `grading_feedback_${uuidv4()}.md`)

    // run test command
    const startTime = new Date().getTime()
    const {output, error} = executeTest(test.run, test.input || '', timeout, cwd, feedbackPath)
    console.log(`Output: ${output}`)
    const endTime = new Date().getTime()

    execution_time = `${(endTime - startTime) / 1000}s`

    if (error) {
      status = 'error'
      err_message = error
      score = (test.points) ? 0 : null
    } else if (!compareOutput(output || '', test.output || '', test.comparison)) {
      status = 'fail'
      err_message = `Output does not match expected. Got: ${output}`
      score = (test.points) ? 0 : null
    }

    // read feedback file
    feedback = fs.readFileSync(feedbackPath, 'utf8')

    // delete feedback file
    if (fs.existsSync(feedbackPath)) {
      fs.unlinkSync(feedbackPath)
    }
  } catch (error) { // TODO: catch specific errors
    status = 'error'
    if (error instanceof Error) {
      // {status, err_message} = getErrorMessageAndStatus(error, test.run)
      err_message = error.message
    } else {
      // status = 'error'
      err_message = `Failed to execute run test: ${test.name}: ${error}`
    }
  }
  if (err_message) console.log(`Error: ${err_message}`)

  return {
    name: test.name,
    status,
    err_message,
    content: feedback || null,
    test_code: `${test.run} <stdin>${test.input || ''}`,
    filename: '',
    line_no: 0,
    execution_time: execution_time || 0,
    score,
  }
}

export const runAll = async (tests: Array<Test>, cwd: string): Promise<void> => {
  let accumulatedPoints = 0
  let availablePoints = 0
  let hasPoints = false
  let status = 'pass'
  let testResults = []

  // create feedback dir
  const feedbackDir = createFeedbackDir()

  // run through all tests
  for (const test of tests) {
    if (test.points) {
      hasPoints = true
      availablePoints += test.points
    }

    console.log(color.cyan(`📝 ${test.name}`))

    const result = runTest(test, cwd, feedbackDir)
    // log outputs during runTest()

    testResults.push(result)

    if (test.points) {
      accumulatedPoints += result.score || 0
    }

    if (result.status === 'pass') {
      console.log(color.green(`✅ ${test.name}`))
    } else {
      console.log(color.red(`❌ ${test.name}`))
      core.setFailed(`Failed to run test '${test.name}'`)
      status = 'error'
    }

    console.log('')
  }

  if (status === 'pass') {
    console.log(color.green(`✅ All tests passed`))
    console.log('')
    console.log('✨🌟💖💎🦄💎💖🌟✨🌟💖💎🦄💎💖🌟✨')
  } else {
    console.log(color.red(`❌ Some tests failed`))
    console.log('')
    // output bugs
    console.log('❗❗🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛🐛❗❗')
  }

  // Set the number of points
  if (hasPoints) {
    const text = `Points ${accumulatedPoints}/${availablePoints}`
    console.log(color.bold.bgCyan.black(text))
    core.setOutput('Points', `${accumulatedPoints}/${availablePoints}`)
    await setCheckRunOutput(text)
  }

  // Output results
  const results = {
    version: 0, // ver 0 because don't know if this is compatible with other reporting systems
    status,
    max_score: availablePoints,
    tests: testResults,
  }
  core.setOutput('result', btoa(JSON.stringify(results)))
}
